/**
 * dsh-provider-proxy — Host half.
 *
 * Routes the model calls of the providers the user enabled through that
 * provider's own forward proxy. Every other provider, and all other DSH
 * traffic, keeps using the normal network path.
 */

import { fetch as undiciFetch } from 'undici'

import { acquireFetchRouter } from './fetch-router.js'
import {
  buildRouteEntry,
  closeTable,
  createProxyTable,
  routeFingerprint,
  routeStateDecision,
  type RouteEntry,
  type RouteState,
} from './proxy-table.js'
import {
  normalizeDefaultProxy,
  type DefaultProxyValue,
  type ProviderProxyRouteValue,
} from './config.js'

export const name = 'dsh-provider-proxy'
export const inject = ['llm']

/**
 * Reserved provider id whose route carries `ctx.web.search` traffic.
 *
 * It lives in the ordinary provider dictionary, so its card, its settings write
 * path, its hit counter and its diagnostics are all the normal ones. A real
 * provider colliding with this id would simply share the route — harmless, and
 * far less likely than the alternative of a separate top-level field needing a
 * special case in every one of those places.
 */
export const WEB_SEARCH_KEY = 'web-search'

/**
 * The Config this fiber receives.
 *
 * It is NOT `ConfigShape`: under the Loader `providers` is a Volatile REFERENCE,
 * not the dictionary, so it has to be read through `.get()`. Declaring the plain
 * shape here made the two incompatible and hid every real value.
 */
interface ProxyConfig {
  /** The provider dictionary, or the Volatile wrapper around it. */
  readonly providers?: unknown
  /** The shared default endpoint, or the Volatile wrapper around it. */
  readonly defaultProxy?: unknown
  /** Whether loopback/private targets stay direct, or the Volatile wrapper. */
  readonly localDirect?: unknown
  /** The self-check URL, or the Volatile wrapper around it. */
  readonly testUrl?: unknown
}

function plainProviders(
  config: ProxyConfig | undefined,
): Record<string, Partial<ProviderProxyRouteValue>> {
  const raw = config?.providers
  if (raw === undefined) return {}
  // Under the Loader this is a Volatile reference; read it fresh every time so
  // a settings write is visible to the next request without a remount.
  const snapshot = (raw as { get?: () => unknown }).get
  const value = typeof snapshot === 'function' ? snapshot.call(raw) : raw
  return (value ?? {}) as Record<string, Partial<ProviderProxyRouteValue>>
}

/** Read the shared default endpoint, which is Volatile under the Loader too. */
function plainDefaultProxy(config: ProxyConfig | undefined): Partial<DefaultProxyValue> {
  const raw = config?.defaultProxy
  if (raw === undefined) return {}
  const snapshot = (raw as { get?: () => unknown }).get
  const value = typeof snapshot === 'function' ? snapshot.call(raw) : raw
  return (value ?? {}) as Partial<DefaultProxyValue>
}

/**
 * Read `localDirect`, Volatile like everything else the settings page writes.
 *
 * Absent or malformed means ON: the default is what keeps a loopback relay from
 * being forced through a proxy that cannot reach it.
 */
function plainLocalDirect(config: ProxyConfig | undefined): boolean {
  const raw = config?.localDirect
  if (raw === undefined) return true
  const snapshot = (raw as { get?: () => unknown }).get
  const value = typeof snapshot === 'function' ? snapshot.call(raw) : raw
  return value !== false
}

export function apply(ctx: any, config?: ProxyConfig): void {
  const router = acquireFetchRouter()
  let current = new Map<string, RouteEntry>()
  let problems = new Map<string, string>()
  let closed = false
  /** Whether a `web` service exists, i.e. whether the reserved route has anything to carry. */
  let webAvailable = false

  // Request counts, keyed by provider id. Held OUTSIDE the proxy table so a
  // rebuild (a settings write) never resets them; only a plugin reload does.
  // Counted at request initiation — see fetch-router.ts.
  const hits = new Map<string, number>()
  /**
   * The immutable identity of the route each request was bound to.
   *
   * `lastUse` answers "does THIS configuration still work", so an in-flight
   * request from an older route must never write to the current one. Tokens are
   * global and never reused, which also makes delete-and-re-add distinguishable
   * from an unchanged provider.
   */
  const routeStates = new Map<string, RouteState>()
  let nextRouteToken = 1
  /**
   * Per-provider liveness. `startedAt` is when the last proxied request BEGAN;
   * `at`/`ok`/`code` describe the last request that FINISHED. They are kept apart
   * because LLM calls are concurrent: a single `at` shared by both would pair one
   * request's start time with another's outcome, and a card could name a failure
   * that belongs to a call which in fact succeeded.
   */
  const lastUse = new Map<string, { startedAt: number; at?: number; ok?: boolean; code?: string }>()
  const bump = (provider: string, token: number): void => {
    hits.set(provider, (hits.get(provider) ?? 0) + 1)
    if (routeStates.get(provider)?.token !== token) return
    // Only the START moves here. The outcome fields are written once a request
    // settles, so an in-flight call cannot overwrite the last COMPLETED result.
    lastUse.set(provider, { ...lastUse.get(provider), startedAt: Date.now() })
  }
  const settle = (provider: string, token: number) => (ok: boolean, detail: unknown): void => {
    if (routeStates.get(provider)?.token !== token) return
    const previous = lastUse.get(provider)
    lastUse.set(provider, {
      startedAt: previous?.startedAt ?? Date.now(),
      // `at` is the FINISH time, written together with the outcome it belongs to.
      at: Date.now(),
      ok,
      code: ok ? String((detail as { status?: unknown } | undefined)?.status ?? '') : failureCodeOf(detail),
    })
  }

  /** Where the self-check sends its request; overridable so a blocked echo host can be replaced. */
  const DEFAULT_TEST_URL = 'https://api.ipify.org?format=json'
  /** How many `testUrl` candidates one check may walk. Bounds the outbound cost. */
  const MAX_TEST_TARGETS = 5
  const TEST_TIMEOUT_MS = 10_000
  /** The self-check body carries one provider id; anything larger is refused, not buffered. */
  const MAX_REQUEST_BYTES = 8 * 1024
  /** One in-flight check per provider, so a repeated click cannot multiply outbound requests. */
  const selfChecks = new Map<string, Promise<Record<string, unknown>>>()
  /**
   * The last COMPLETED check per provider, with its finish time. A click inside
   * the cooldown gets the remembered answer back instead of a new outbound
   * request: the in-flight dedup above only merges CONCURRENT checks, so without
   * this, a slow echo target could be hammered serially by impatient clicks.
   * The answer is the truth about a configuration that has not changed — not a
   * stale value — and it is marked `cached` so a caller can tell.
   */
  const SELF_CHECK_COOLDOWN_MS = 3_000
  const lastChecks = new Map<string, { at: number; result: Record<string, unknown> }>()

  /**
   * Read `testUrl`, which is Volatile under the Loader and therefore needs
   * `.get()`.
   *
   * It may name SEVERAL candidates, separated by commas or whitespace: any single
   * public echo host can be unreachable on some networks, and a check that fails
   * for that reason is a check nobody trusts. The list is capped so a long one
   * cannot quietly multiply outbound requests.
   */
  const plainTestUrls = (): string[] => {
    const raw = (config as { testUrl?: unknown } | undefined)?.testUrl
    const snapshot = (raw as { get?: () => unknown } | undefined)?.get
    const value = typeof snapshot === 'function' ? snapshot.call(raw) : raw
    const list =
      typeof value === 'string'
        ? value
            .split(/[,\s]+/)
            .map(entry => entry.trim())
            .filter(entry => entry.length > 0)
        : []
    return list.length > 0 ? list.slice(0, MAX_TEST_TARGETS) : [DEFAULT_TEST_URL]
  }

  /** Walk `path` down a value, giving up at the first non-object. */
  const walk = (value: unknown, path: readonly unknown[]): unknown => {
    let node = value
    for (const key of path) {
      if (node === null || typeof node !== 'object') return undefined
      node = (node as Record<string, unknown>)[key as string]
    }
    return node
  }

  /**
   * The endpoint a provider actually calls, when its adapter publishes one.
   *
   * Read from the adapter's SETTINGS SECTION rather than from `listProviders()`,
   * which carries only `{ id, name }`. `listConfigurableProviders()` supplies the
   * address — the settings namespace plus the path to the route's profile — and
   * that is exactly what a configuration surface is meant to consume.
   *
   * Everything here is optional and defensively read: a composition without the
   * settings service, an adapter that registers no section, or a profile that
   * stores no address all simply yield `undefined`, and the caller falls back to
   * the top-level `testUrl` exactly as before.
   */
  const upstreamOf = (provider: string): string | undefined => {
    let settings: any
    try {
      settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
    } catch {
      return undefined
    }
    if (settings === undefined || typeof settings.get !== 'function') return undefined
    let entry: any
    try {
      const entries: any[] = ctx.llm?.listConfigurableProviders?.() ?? []
      entry = entries.find(candidate => candidate?.provider === provider)
    } catch {
      return undefined
    }
    if (entry === undefined) return undefined
    let profile: unknown
    try {
      profile = walk(settings.get(entry.settingsNs), entry.settingsPath ?? [])
    } catch {
      return undefined
    }
    const baseURL = (profile as { baseURL?: unknown } | undefined)?.baseURL
    return typeof baseURL === 'string' && baseURL.trim().length > 0 ? baseURL.trim() : undefined
  }

  /**
   * The `dsh-provider-proxy: ` prefix on a recorded problem is a Host-log
   * convention. Both endpoints that serve the settings page are UI payloads, so
   * the prefix is stripped at the boundary; `providerProxyState` and the log
   * keep the string exactly as the table recorded it.
   */
  const bareMessage = (message: string): string => message.replace(/^dsh-provider-proxy:\s*/, '')

  /**
   * Every error reachable from one throw: the value itself, its `cause` chain,
   * and any `AggregateError.errors` on the way.
   *
   * `fetch` wraps a connection failure as `TypeError: fetch failed` and hides
   * the real `ECONNREFUSED` in `cause`, so a classifier that only reads the top
   * value cannot tell "the proxy is down" from "the target refused".
   */
  const causesOf = (error: unknown): unknown[] => {
    const out: unknown[] = []
    const seen = new Set<unknown>()
    const queue: unknown[] = [error]
    while (queue.length > 0) {
      const node = queue.shift()
      if (node === null || typeof node !== 'object' || seen.has(node)) continue
      seen.add(node)
      out.push(node)
      const cause = (node as { cause?: unknown }).cause
      if (cause !== undefined && cause !== null) queue.push(cause)
      const errors = (node as { errors?: unknown }).errors
      if (Array.isArray(errors)) queue.push(...errors)
    }
    return out
  }

  /**
   * Classify a self-check failure so the report points at the hop that actually
   * failed.
   *
   * `viaProxy` decides WHICH hop that is: the same connection error means "the
   * proxy is unreachable" on a proxied probe but "the target is unreachable" on a
   * direct one. Naming the proxy for a direct probe would send the operator after
   * a hop the check never used.
   */
  const classifyTestError = (
    error: unknown,
    viaProxy: boolean,
    rawTarget: string,
  ): { kind: string; error: string } => {
    const chain = causesOf(error)
    const names = chain
      .map(node => (node as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string')
    const codes = chain
      .map(node => (node as { code?: unknown }).code)
      .filter((code): code is string => typeof code === 'string')
    // undici THROWS on a proxy 407 rather than returning the response, and the
    // only place the "407" appears is a CAUSE's message ("Proxy Authentication
    // Required (407)") — the top-level message is the generic "fetch failed". So
    // the whole chain is searched, not just the value that was thrown.
    const messages = chain
      .map(node => (node as { message?: unknown }).message)
      .filter((text): text is string => typeof text === 'string')
    // The thrown message may quote the raw target, including userinfo or a
    // query token. Keep the useful classification but never pass that message
    // through verbatim.
    const message = redactTargetFromText(
      error instanceof Error ? error.message : String(error),
      rawTarget,
    )
    if (names.includes('TimeoutError') || names.includes('AbortError')) {
      return { kind: 'timeout', error: `超时（${TEST_TIMEOUT_MS / 1000}s）：代理或目标无响应` }
    }
    const connectivity = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN']
    const code = connectivity.find(candidate => codes.includes(candidate))
    if (code !== undefined) {
      return viaProxy
        ? { kind: 'proxy-unreachable', error: `代理不可达（${code}）：${message}` }
        : { kind: 'target', error: `目标不可达（${code}）：${message}` }
    }
    if (names.includes('ProxyAuthentication') || messages.some(text => text.includes('407'))) {
      return { kind: 'proxy-auth', error: `代理要求认证（HTTP 407）：${message}` }
    }
    return { kind: 'target', error: `请求失败：${message}` }
  }

  /**
   * Collapse a target to the origin and pathname for display.
   *
   * Userinfo, query values and fragments are removed before the value is
   * returned to the page. Invalid targets lose a `scheme://userinfo@` prefix and
   * everything from the first query/fragment marker, then are bounded in length.
   */
  const sanitizeTargetForDisplay = (target: string): string => {
    const raw = String(target ?? '')
    try {
      const url = new URL(raw)
      return `${url.protocol}//${url.host}${url.pathname}`
    } catch {
      const withoutUserinfo = raw.replace(
        /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/i,
        '$1',
      )
      const withoutQuery = withoutUserinfo.split(/[?#]/, 1)[0] ?? ''
      const bounded = withoutQuery.length > 160 ? `${withoutQuery.slice(0, 160)}…` : withoutQuery
      return bounded
    }
  }

  /** Remove a raw target (and URL secrets) from a Host-generated error. */
  const redactTargetFromText = (text: string, rawTarget: string): string => {
    let safe = text
    if (rawTarget.length > 0) safe = safe.split(rawTarget).join('[目标已脱敏]')
    // The error chain may contain the target in a re-serialized form, so strip
    // every URLs credentials and query/fragment tail, not only the exact input.
    safe = safe.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1')
    safe = safe.replace(/([?&#])[^\s"'<>]*/g, '$1')
    return safe.length > 500 ? `${safe.slice(0, 500)}…` : safe
  }

  /**
   * A short machine code for a transport failure, for a card's "last failure".
   *
   * Walks the same cause chain the self-check classifier does: `fetch` hides the
   * real code one or two levels down, so reading only the top value would report
   * a useless "fetch failed" for every kind of outage.
   */
  const failureCodeOf = (error: unknown): string => {
    const chain = causesOf(error)
    const names = chain
      .map(node => (node as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string')
    if (names.includes('TimeoutError')) return 'TIMEOUT'
    if (names.includes('AbortError')) return 'ABORTED'
    for (const node of chain) {
      const code = (node as { code?: unknown }).code
      if (typeof code === 'string' && code.length > 0) return code
    }
    return 'ERROR'
  }

  /**
   * Send one request to ONE target, honoured the way real traffic would be.
   *
   * The proxy/direct decision comes from the route's OWN `decide`, exactly as a
   * live request consults it: a loopback/private target, a `bypassHosts` match,
   * or an `onlyHosts` miss goes DIRECT, and only a proxied probe carries the
   * dispatcher. This matters most now that the check defaults to the provider's
   * real upstream: a local relay upstream (LiteLLM, Ollama) would otherwise be
   * forced through a forward proxy that cannot reach it, and the check would
   * report a healthy route as "the proxy is broken" — the very false positive
   * `localDirect` exists to remove.
   *
   * When it IS proxied, the dispatcher is passed EXPLICITLY rather than by
   * entering the router's AsyncLocalStorage scope: that scope intercepts
   * `globalThis.fetch`, so a plain `undici.fetch` call would go straight out and
   * report a broken proxy as a success — the one failure this whole feature
   * exists to eliminate.
   */
  const probeTarget = async (
    target: string,
    route: RouteEntry,
  ): Promise<Record<string, unknown>> => {
    const displayTarget = sanitizeTargetForDisplay(target)
    let host: string | undefined
    try {
      host = new URL(target).hostname
    } catch {
      return {
        ok: false,
        kind: 'target',
        target: displayTarget,
        error: `自检目标不是合法 URL：${displayTarget}`,
      }
    }
    const viaProxy = route.decide(host) === 'proxy'
    const started = performance.now()
    try {
      // WHATWG URL keeps userinfo out of `origin`, but the request URL still
      // carries it. The self-check never needs embedded credentials, so remove
      // them from the request too rather than merely hiding them on display.
      const requestTarget = ((): string => {
        const url = new URL(target)
        url.username = ''
        url.password = ''
        return url.toString()
      })()
      const response = await undiciFetch(requestTarget, {
        // A direct probe must NOT carry the dispatcher, or undici would force it
        // through the proxy anyway.
        ...(viaProxy ? { dispatcher: route.dispatcher } : {}),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      } as never)
      const ms = Math.round(performance.now() - started)
      const targetField = { target: displayTarget }
      // 407 is the proxy demanding credentials: a RESULT, not a throw. Only a
      // proxied request can be answered by a proxy this way.
      if (viaProxy && response.status === 407) {
        return {
          ok: false,
          ms,
          status: 407,
          kind: 'proxy-auth',
          viaProxy,
          ...targetField,
          error: `代理要求认证（HTTP 407）：${displayTarget}`,
        }
      }
      let exitIp: string | undefined
      try {
        const body = (await response.json()) as { ip?: unknown } | null
        if (typeof body?.ip === 'string' && body.ip.length > 0) exitIp = body.ip
      } catch {
        // A non-JSON echo still proves the request crossed the proxy.
      }
      // Any status below 500 means the request DID reach something — the target
      // when it went direct, or the far side of the proxy. Against a real upstream
      // a bare GET normally answers 4xx (401/404) — the expected answer, and
      // proof the path works. A 5xx is the opposite: an HTTP proxy that cannot
      // reach its upstream answers 502/503/504 ITSELF, so it reads as a broken
      // path rather than a refused request.
      const reachable = response.status < 500
      if (reachable) {
        return {
          ok: true,
          ms,
          status: response.status,
          viaProxy,
          ...targetField,
          ...(exitIp === undefined ? {} : { exitIp }),
          kind: 'ok',
        }
      }
      return {
        ok: false,
        ms,
        status: response.status,
        viaProxy,
        ...targetField,
        kind: 'target',
        // The status travels in its own field; the reason text must not repeat
        // it, or the page shows the same code twice in different colours.
        error: `目标返回 5xx（上游或链路异常）：${displayTarget}`,
      }
    } catch (error) {
      return {
        ok: false,
        ms: Math.round(performance.now() - started),
        viaProxy,
        ...classifyTestError(error, viaProxy, target),
        target: displayTarget,
      }
    }
  }

  /**
   * Every target this check may try, in order.
   *
   * A route's own `testTarget` first, then the provider's REAL upstream when its
   * adapter publishes one, then the top-level `testUrl` — which may itself name
   * several echo services.
   *
   * Takes the target as a plain string so the cooldown key can call it too, with
   * the raw config's value: the key must be built from the SAME resolution the
   * check uses, or the two can disagree about what the next request would try.
   */
  /**
   * The check's targets, and WHERE they came from.
   *
   * The target is NOT always the top-level `testUrl`: a route's own
   * `testTarget` wins, then the provider's REAL upstream, and only a provider
   * that publishes none falls back to `testUrl`. Without this the page cannot
   * explain why editing `testUrl` changed one card and not another.
   *
   * The upstream is read ONCE: reading it twice could disagree if the settings
   * service moved in between, and the target list and the reported source must
   * never contradict each other.
   */
  const selfCheckTargetsOf = (
    provider: string,
    testTarget: string | undefined,
  ): { targets: string[]; source: 'route' | 'upstream' | 'testUrl' } => {
    const own = (testTarget ?? '').trim()
    if (own.length > 0) return { targets: [own], source: 'route' }
    const upstream = upstreamOf(provider)
    if (upstream !== undefined) return { targets: [upstream], source: 'upstream' }
    return { targets: plainTestUrls(), source: 'testUrl' }
  }

  /**
   * A fingerprint of every input that can change one provider's check ANSWER.
   *
   * The cooldown is a cache, and a cache keyed only by provider would answer a
   * question about a configuration the user has since edited. The route's own
   * transport fields are used, plus `testTarget`; when the route opts into the
   * shared endpoint, that endpoint's fields are what actually carry the request,
   * so they are folded in instead.
   *
   * `onlyHosts`/`bypassHosts`/`localDirect` and the resolved target list are part
   * of the answer too, and each one changes it visibly: they decide whether the
   * probe is proxied or direct (`viaProxy`), and the target list is where the
   * top-level `testUrl` enters when the route names no target of its own. Leaving
   * them out meant an edit inside the cooldown handed back the pre-edit verdict
   * with `cached: true` and issued no request at all. It is held in memory only
   * and never logged.
   */
  const selfCheckKey = (provider: string): string => {
    const raw = plainProviders(config)[provider] ?? {}
    const endpoint =
      raw.useDefault === true
        ? (plainDefaultProxy(config) as Partial<ProviderProxyRouteValue>)
        : raw
    return JSON.stringify([
      provider,
      endpoint.protocol ?? 'http',
      endpoint.host ?? '',
      endpoint.port ?? 0,
      endpoint.username ?? '',
      endpoint.password ?? '',
      raw.testTarget ?? '',
      raw.onlyHosts ?? '',
      raw.bypassHosts ?? '',
      plainLocalDirect(config),
      selfCheckTargetsOf(provider, raw.testTarget).targets,
    ])
  }

  /**
   * Run the connection self-check for one provider.
   *
   * A route the table carries is used directly — including one the guards
   * REJECTED, whose recorded problem is what explains it. A route that is merely
   * CONFIGURED gets a dispatcher built for this check alone, through the SAME
   * builder routing uses, so a setting can be verified BEFORE it is switched on
   * and a bad one is reported with the reason routing would have given.
   */
  const runSelfCheck = async (provider: string): Promise<Record<string, unknown>> => {
    let route = current.get(provider)
    let temporary = false
    if (route === undefined) {
      // Two very different reasons land here. A route the guards REJECTED (a bad
      // port, an HTTP password with no username) is missing from the table too,
      // and answering "not enabled" for it names a cause that is not the case —
      // the setting IS on. The problem the table recorded is what explains it.
      const problem = problems.get(provider)
      if (problem !== undefined) {
        return { ok: false, kind: 'route-rejected', error: bareMessage(problem) }
      }
      const configured = plainProviders(config)[provider]
      if (configured === undefined || configured.enabled === true) {
        return { ok: false, kind: 'no-route', error: `provider "${provider}" 未启用代理` }
      }
      const built = buildRouteEntry(provider, configured, {
        defaultProxy: normalizeDefaultProxy(plainDefaultProxy(config)),
        requireEnabled: false,
        localDirect: plainLocalDirect(config),
      })
      if (!built.ok) {
        return { ok: false, kind: 'route-rejected', error: bareMessage(built.problem) }
      }
      route = built.entry
      temporary = true
    }
    try {
      let last: Record<string, unknown> | undefined
      const { targets, source } = selfCheckTargetsOf(provider, route.testTarget)
      for (const target of targets) {
        const outcome = await probeTarget(target, route)
        if (outcome.ok === true) return { ...outcome, targetSource: source }
        last = outcome
        // 407 is about the PROXY, not the target: another candidate would ask the
        // same question and get the same answer.
        if (outcome.kind === 'proxy-auth') break
      }
      return last === undefined
        ? { ok: false, kind: 'target', target: '', targetSource: source, error: '没有可用的自检目标' }
        : { ...last, targetSource: source }
    } finally {
      // A dispatcher built for one check must not outlive it: the table owns the
      // long-lived ones, and this one was never in the table to begin with.
      if (temporary) await route.dispatcher.close().catch(() => undefined)
    }
  }

  // One line on activation so a user can tell "mounted" from "not mounted" in
  // the Host log without guessing. Never prints a credential.
  try {
    ctx.logger.info('dsh-provider-proxy mounted (pid %d)', process.pid)
  } catch {
    // A context without a logger still works; the diagnostics getter remains.
  }

  const rebuild = (): Promise<void> => {
    // One snapshot feeds the table, the route-state diff and every cleanup.
    // Reading the Volatile fields more than once could mix two settings writes.
    const providers = plainProviders(config)
    const defaultProxy = plainDefaultProxy(config)
    const localDirect = plainLocalDirect(config)
    const next = createProxyTable(providers, { defaultProxy, localDirect })
    const previous = current
    current = next.entries
    problems = next.problems

    const configured = new Set(Object.keys(providers))
    for (const provider of [...routeStates.keys()]) {
      if (configured.has(provider)) continue
      routeStates.delete(provider)
      lastUse.delete(provider)
    }

    for (const [provider, raw] of Object.entries(providers)) {
      const effective =
        raw?.useDefault === true
          ? { ...raw, ...defaultProxy }
          : raw
      const fingerprint = routeFingerprint({
        ...effective,
        localDirect,
      })
      const decision = routeStateDecision(routeStates.get(provider), {
        fingerprint,
        enabled: raw?.enabled === true,
      })
      const token = decision.token === 'new' ? nextRouteToken++ : routeStates.get(provider)!.token
      if (decision.clearLastUse) lastUse.delete(provider)
      routeStates.set(provider, { fingerprint, enabled: raw?.enabled === true, token })
    }
    // Retire the previous table only after the new one is live, so an in-flight
    // stream keeps a dispatcher that still works.
    void closeTable(previous)
    return Promise.resolve()
  }

  let rebuildQueue = Promise.resolve()
  const enqueueRebuild = (): Promise<void> => {
    if (closed) return Promise.resolve()
    // The table build is synchronous; commit immediately to preserve apply()'s
    // long-standing "catalog is usable as soon as apply returns" contract.
    // `rebuildQueue` still records the completion for disposal ordering.
    try {
      const done = rebuild()
      rebuildQueue = rebuildQueue.then(() => done).catch(() => undefined)
      return done
    } catch (error) {
      const failed = Promise.reject(error)
      rebuildQueue = failed.catch(() => undefined)
      return failed
    }
  }

  enqueueRebuild()

  /**
   * The provider catalogue, read from `ctx.llm` where it is actually available.
   *
   * The browser has no LLM service in this release, so the page cannot ask for
   * this list itself. Serving it from the Host is the supported path: the
   * `webServer` service is confirmed live, and the shipped dsh-llm-retry-settings
   * registers its routes the same way.
   */
  const catalog = (): { providers: { id: string; name: string; live: boolean }[] } => {
    const live = new Set<string>()
    const out: { id: string; name: string; live: boolean }[] = []
    const seen = new Set<string>()
    try {
      for (const entry of ctx.llm?.listProviders?.() ?? []) {
        const id = entry?.id
        if (typeof id !== 'string' || id.length === 0) continue
        live.add(id)
        if (seen.has(id)) continue
        seen.add(id)
        const name = typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : id
        out.push({ id, name, live: true })
      }
    } catch {
      // no llm service in this composition
    }
    try {
      for (const entry of ctx.llm?.listConfigurableProviders?.() ?? []) {
        const id = entry?.provider
        if (typeof id !== 'string' || id.length === 0) continue
        const name =
          typeof entry.displayName === 'string' && entry.displayName.length > 0 ? entry.displayName : id
        const existing = out.find(row => row.id === id)
        if (existing === undefined) out.push({ id, name, live: live.has(id) })
        else existing.name = name
      }
    } catch {
      // ignore
    }
    // The reserved route rides in the provider dictionary, so its card and its
    // settings write path are the ordinary ones; publishing a row is what lets
    // the page render it without a special case. It appears only when the web
    // service actually exists — otherwise there is nothing for it to route.
    if (webAvailable && out.every(row => row.id !== WEB_SEARCH_KEY)) {
      out.push({ id: WEB_SEARCH_KEY, name: 'Web 搜索', live: true })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return { providers: out }
  }

  // The page reads this same-origin JSON endpoint for the provider list. Mounted
  // inside an optional child so a composition without a web server still runs.
  ctx.inject?.(['webServer'], (wctx: any) => {
    try {
      wctx?.webServer?.register?.({
        kind: 'exact',
        path: '/dsh-provider-proxy/providers',
        handler: (_req: unknown, res: any) => {
          try {
            const text = JSON.stringify({
              ...catalog(),
              problems: Object.fromEntries(
                [...problems].map(([id, message]) => [id, bareMessage(message)]),
              ),
              hits: Object.fromEntries(hits),
              lastUse: Object.fromEntries(lastUse),
            })
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(text),
            })
            res.end(text)
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ providers: [], error: String(error) }))
          }
        },
      })

      // Connection self-check: one request through the provider's own dispatcher.
      // POST-only, the provider must be in the LIVE table, and at most one check
      // per provider is in flight — so this cannot become an outbound amplifier.
      wctx?.webServer?.register?.({
        kind: 'exact',
        path: '/dsh-provider-proxy/test',
        handler: (req: any, res: any) => {
          // One response per request, whatever arrives later: an aborted
          // connection can fire 'error', and a body that was already refused can
          // still be followed by 'end'.
          let replied = false
          const send = (status: number, payload: unknown): void => {
            if (replied) return
            replied = true
            const text = JSON.stringify(payload)
            res.writeHead(status, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              'content-length': Buffer.byteLength(text),
            })
            res.end(text)
          }
          if (req?.method !== 'POST') {
            send(405, { ok: false, kind: 'method', error: '自检端点只接受 POST' })
            return
          }
          if (typeof req.on !== 'function') {
            send(400, { ok: false, kind: 'body', error: '无法读取请求体' })
            return
          }
          let bytes = 0
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => {
            if (replied) return
            bytes += chunk.length
            // The body is one provider id. Anything larger is not a caller this
            // endpoint serves, and buffering it would be a free memory sink on a
            // webServer deployments may bind beyond loopback. The rest of the
            // stream is discarded rather than read.
            if (bytes > MAX_REQUEST_BYTES) {
              send(413, {
                ok: false,
                kind: 'body',
                error: `请求体超过 ${MAX_REQUEST_BYTES} 字节上限`,
              })
              return
            }
            chunks.push(chunk)
          })
          req.on('error', () => send(400, { ok: false, kind: 'body', error: '读取请求体失败' }))
          req.on('end', () => {
            if (replied) return
            void (async () => {
              let provider: unknown
              try {
                const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
                provider = (parsed as { provider?: unknown })?.provider
              } catch {
                send(400, { ok: false, kind: 'body', error: '请求体不是合法 JSON' })
                return
              }
              if (typeof provider !== 'string' || provider.length === 0) {
                send(400, { ok: false, kind: 'body', error: '缺少 provider' })
                return
              }
              // Every input the check's ANSWER depends on, so the cooldown below
              // cannot hand back a result that belonged to a DIFFERENT
              // configuration. Without this, a user who tests, sees a failure,
              // fixes the port, and re-tests within the cooldown would be shown
              // the pre-fix result and think the fix did nothing.
              const key = selfCheckKey(provider)
              let pending = selfChecks.get(key)
              if (pending === undefined) {
                const last = lastChecks.get(key)
                if (last !== undefined && Date.now() - last.at < SELF_CHECK_COOLDOWN_MS) {
                  send(200, { ...last.result, cached: true })
                  return
                }
                pending = runSelfCheck(provider).then(result => {
                  lastChecks.set(key, { at: Date.now(), result })
                  return result
                })
                selfChecks.set(key, pending)
                void pending.finally(() => {
                  if (selfChecks.get(key) === pending) selfChecks.delete(key)
                })
              }
              send(200, await pending)
            })().catch((error: unknown) => {
              send(500, { ok: false, kind: 'internal', error: String(error) })
            })
          })
        },
      })
    } catch (error) {
      // The page degrades to whatever is already configured.
      void error
    }
  })

  // `web_search` reaches the network with a bare global `fetch`, and `ctx.web`
  // exposes no waterfall to hook. Wrapping the service METHOD is therefore the
  // only seam. Entering the router scope around the call is enough — the scope
  // propagates through `await`, and the search is await-to-completion rather than
  // a lazily-consumed stream, so no per-iterator wrapping is needed here.
  //
  // Two preconditions make this work, and a future provider could break either:
  // the tool accesses `ctx.web.search` afresh on every call (no early
  // destructure), and the provider's `search()` awaits to completion.
  ctx.inject?.(['web'], (wctx: any) => {
    const web = wctx?.web
    if (web === undefined || typeof web.search !== 'function') return
    webAvailable = true
    const original = web.search
    const patched = function (this: unknown, request: unknown, signal?: unknown): unknown {
      const route = current.get(WEB_SEARCH_KEY)
      if (route === undefined) return original.call(this, request, signal)
      const token = routeStates.get(WEB_SEARCH_KEY)?.token
      if (token === undefined) return original.call(this, request, signal)
      return router.run(
        {
          dispatcher: route.dispatcher,
          onHit: () => bump(WEB_SEARCH_KEY, token),
          onSettle: settle(WEB_SEARCH_KEY, token),
          decide: route.decide,
        },
        () => original.call(this, request, signal),
      )
    }
    web.search = patched
    // Restore on dispose: `ctx.web` is a Cordis traceable proxy, so READING
    // `web.search` returns a fresh wrapper every time and `web.search === patched`
    // can never be true — a guard written that way never fires. The own property
    // is the only place the installed function is actually observable, and
    // deleting it is the real restore: it drops our property and lets the
    // prototype method show through, where reassigning would leave an own
    // property shadowing the prototype forever.
    //
    // A plugin that wrapped the method AFTER us installed its own property, so
    // this guard deliberately leaves that wrapper in place.
    const registerEffect = typeof wctx?.effect === 'function' ? wctx.effect.bind(wctx) : ctx.effect?.bind(ctx)
    registerEffect?.(() => () => {
      if (Object.getOwnPropertyDescriptor(web, 'search')?.value === patched) delete web.search
    })
  })

  ctx.effect(() => {
    const stop = ctx.on(
      'llm/stream',
      (options: { provider?: string }, next: () => AsyncIterable<unknown>) => {
        const provider = options?.provider
        if (typeof provider !== 'string') return next()
        const route = current.get(provider)
        if (route === undefined) return next()
        const token = routeStates.get(provider)?.token
        if (token === undefined) return next()
        // The stream is consumed lazily; wrap it so the scope survives. The hit
        // counter rides inside the scope, so an abandoned stream still counts.
        return router.wrap(
          {
            dispatcher: route.dispatcher,
            onHit: () => bump(provider, token),
            onSettle: settle(provider, token),
            decide: route.decide,
          },
          next as () => AsyncIterable<unknown>,
        )
      },
      { global: true },
    )

    const onConfig = (): void => {
      void enqueueRebuild()
    }
    ctx.on('loader/volatile-update', onConfig, { global: true })

    return async () => {
      stop()
      if (closed) return
      closed = true
      await rebuildQueue.catch(() => undefined)
      await closeTable(current)
      current = new Map()
      router.release()
    }
  }, 'dsh-provider-proxy: provider-scoped proxy routing')

  // Diagnostics, exported for the Host log and for tests. Never includes a
  // password: `proxyOrigin` is the sanitized origin only.
  Object.defineProperty(ctx, 'providerProxyState', {
    configurable: true,
    get: () => ({
      routes: [...current.values()].map(entry => ({
        provider: entry.provider,
        proxyOrigin: entry.proxyOrigin,
      })),
      problems: Object.fromEntries(problems),
      hits: Object.fromEntries(hits),
      lastUse: Object.fromEntries(lastUse),
    }),
  })
}

export { acquireFetchRouter } from './fetch-router.js'
export { buildRouteEntry, createProxyTable, closeTable, proxyUrl, routeFingerprint, routeStateDecision } from './proxy-table.js'
export { Config, ProviderProxyRoute, normalizeRoute, normalizeDefaultProxy, PROTOCOLS } from './config.js'
export { defaultProxyProblem, proxyHostProblem } from './proxy-address.js'
export { deadRuleEntries, hostMatches, hostRuleProblem, parseHostList, splitHostRules } from './host-rules.js'
