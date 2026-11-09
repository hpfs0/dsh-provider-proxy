export interface HeartbeatState {
  status: 'healthy' | 'unreachable'
  lastCheckAt: number
  lastSuccessAt?: number
  latencyMs: number | null
  error?: string
  fails: number
}
/**
 * dsh-provider-proxy — Host half.
 *
 * Routes the model calls of the providers the user enabled through that
 * provider's own forward proxy. Every other provider, and all other DSH
 * traffic, keeps using the normal network path.
 */

import { fetch as undiciFetch } from 'undici'

import { acquireFetchRouter, type DispatcherLike } from './fetch-router.js'
import {
  buildRouteEntry,
  closeTable,
  createProxyTable,
  routeCheckIdentity,
  routeFingerprint,
  routeStateDecision,
  type RouteEntry,
  type RouteState,
} from './proxy-table.js'
import {
  normalizeDefaultProxy,
  normalizeHeartbeatConfig,
  type DefaultProxyValue,
  type ProviderProxyRouteValue,
} from './config.js'
import { detectProxyEnv } from './proxy-env.js'
import { effectiveRoute, type ProfileMap } from './presets.js'
import {
  normalizeSearchSplitConfig,
  resolveSearchPlan,
  searchSplitProblem,
  type SearchPlan,
  type SearchSplitConfig,
} from './search-split.js'

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
 * The id the dedicated search dispatcher is built under (N24).
 *
 * It is deliberately NOT a provider id: the entry never enters `current`, so it
 * cannot appear as a card, be probed by the heartbeat, or be edited in the
 * provider dictionary. It exists only for the `llm` router's sibling seam,
 * `ctx.web.search`, and is rebuilt from `searchProxyProfileId` whenever the
 * settings change.
 */
const SEARCH_DEDICATED_KEY = 'search-split'

/** Search traffic counters, published for the dashboard's `[搜索]` classification. */
export interface SearchTrafficState {
  /** The configured strategy, after normalization. */
  strategy: SearchSplitConfig['searchProxyStrategy']
  /** The bound preset id ('' means the web-search card's own endpoint). */
  profileId: string
  /** The chain the NEXT search call would take. */
  plan: SearchPlan['kind']
  /** Why that chain was chosen, for the page's explanation. */
  reason: SearchPlan['reason']
  /** The dedicated endpoint's credential-free origin, when one is built. */
  endpoint?: string
  /** Why search traffic cannot be routed, when the plan is blocked. */
  problem?: string
  /** Search calls initiated (proxied + direct + failed). */
  hits: number
  /** Calls that left through a proxy. */
  proxied: number
  /** Calls that used the native network path. */
  direct: number
  /** Calls that failed outright. */
  failed: number
  /** When the most recent search call began. */
  lastAt?: number
  /** Whether the last completed call got a usable answer. */
  ok?: boolean
  /** The status or failure code of the last completed call. */
  code?: string
}

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
  /** The named preset dictionary, or the Volatile wrapper around it. */
  readonly proxyProfiles?: unknown
  /** The shared default endpoint, or the Volatile wrapper around it. */
  readonly defaultProxy?: unknown
  /** Whether loopback/private targets stay direct, or the Volatile wrapper. */
  readonly localDirect?: unknown
  /** Whether to fallback to direct connection when proxy is down. */
  readonly enableFallbackDirect?: unknown
  readonly bypassAll?: unknown
  /** The self-check URL, or the Volatile wrapper around it. */
  readonly testUrl?: unknown
  readonly heartbeatEnabled?: unknown
  readonly heartbeatInterval?: unknown
  readonly heartbeatConsecutiveFails?: unknown
  /** Which chain carries `web_search` traffic (N24), or the Volatile wrapper. */
  readonly searchProxyStrategy?: unknown
  /** The preset a `dedicated` search strategy routes through, or the wrapper. */
  readonly searchProxyProfileId?: unknown
}

function plainProviders(
  config: ProxyConfig | undefined,
): Record<string, Partial<ProviderProxyRouteValue>> {
  return plainDict<Partial<ProviderProxyRouteValue>>(config?.providers, {})
}

/** Read one Volatile dictionary field; absent means an empty dictionary. */
function plainDict<T>(field: unknown, fallback: Record<string, T>): Record<string, T> {
  const raw = field
  if (raw === undefined) return fallback
  // Under the Loader this is a Volatile reference; read it fresh every time so
  // a settings write is visible to the next request without a remount.
  const snapshot = (raw as { get?: () => unknown }).get
  const value = typeof snapshot === 'function' ? snapshot.call(raw) : raw
  return (value ?? fallback) as Record<string, T>
}

/** Read the named presets, which are Volatile like every other setting. */
function plainProfiles(config: ProxyConfig | undefined): ProfileMap {
  return plainDict<Partial<DefaultProxyValue>>(config?.proxyProfiles, {})
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

/** Unwrap a schemastery `.volatile()` fiber field: `.get()` when present, else the raw value. */
function fiberValue(raw: unknown): unknown {
  const snapshot = (raw as { get?: () => unknown } | undefined)?.get
  return typeof snapshot === 'function' ? snapshot.call(raw as never) : raw
}

const fiberBool = (raw: unknown): boolean => fiberValue(raw) === true
const fiberNumber = (raw: unknown): number | undefined => {
  const value = Number(fiberValue(raw))
  return Number.isFinite(value) ? value : undefined
}

function plainBypassAll(config: ProxyConfig | undefined): boolean {
  return fiberBool(config?.bypassAll)
}


function plainHeartbeatEnabled(config: ProxyConfig | undefined): boolean {
  return normalizeHeartbeatConfig({ heartbeatEnabled: fiberValue(config?.heartbeatEnabled) as boolean | undefined }).heartbeatEnabled
}

function plainHeartbeatInterval(config: ProxyConfig | undefined): number {
  return normalizeHeartbeatConfig({ heartbeatInterval: fiberNumber(config?.heartbeatInterval) }).heartbeatInterval
}

function plainHeartbeatConsecutiveFails(config: ProxyConfig | undefined): number {
  return normalizeHeartbeatConfig({ heartbeatConsecutiveFails: fiberNumber(config?.heartbeatConsecutiveFails) }).heartbeatConsecutiveFails
}
function plainEnableFallbackDirect(config: ProxyConfig | undefined): boolean {
  return fiberBool(config?.enableFallbackDirect)
}

/**
 * Read the two search-split settings, Volatile like every other setting.
 *
 * Normalized through the shared module rather than compared field by field: the
 * page's preview and the Host's decision must answer the same question from the
 * same draft, and an unknown strategy must degrade to `inherit` here too.
 */
function plainSearchSplit(config: ProxyConfig | undefined): SearchSplitConfig {
  return normalizeSearchSplitConfig({
    searchProxyStrategy: fiberValue(config?.searchProxyStrategy),
    searchProxyProfileId: fiberValue(config?.searchProxyProfileId),
  })
}

export function apply(ctx: any, config?: ProxyConfig): void {
  const router = acquireFetchRouter()
  let current = new Map<string, RouteEntry>()
  /**
   * The settings identity each live route was built from, keyed by provider.
   *
   * Deliberately NOT a field on `RouteEntry`: the identity folds in the
   * credential (a password edit must change it), and a route entry is
   * serialized into diagnostics — the standing invariant there is that no entry
   * ever carries a secret. Kept next to `current` because it must be replaced in
   * the same rebuild that replaces the routes.
   */
  let liveCheckIdentities = new Map<string, string>()
  let problems = new Map<string, string>()
  let closed = false
  /**
   * Dispatchers a stream may still issue its request on, with a retirement flag.
   *
   * A settings write rebuilds the table and retires the previous generation, but a
   * stream created BEFORE the write is consumed AFTER it — an adapter only runs on
   * its first `next()`. Closing that generation immediately failed a request the
   * user had already started, so retirement waits for the last claim: the scope's
   * first request, or the stream ending without one (see
   * `RouterStore.onLeaseRelease`).
   *
   * A stream that is neither consumed nor closed keeps its claim — and with it an
   * idle dispatcher — until the plugin is disposed. That is bounded by the number
   * of abandoned streams, and the alternative (closing blind) is the defect this
   * exists to fix.
   */
  const dispatcherClaims = new Map<DispatcherLike, { count: number; retired: boolean }>()

  /**
   * Take a claim on one dispatcher; the returned release is idempotent.
   *
   * `onLeaseRelease` fires at most twice in practice (once when the request
   * starts, once when the stream ends), and a duplicate release must not decrement
   * twice — that would close a dispatcher another stream still needs.
   */
  const claimDispatcher = (dispatcher: DispatcherLike): (() => void) => {
    let record = dispatcherClaims.get(dispatcher)
    if (record === undefined) {
      record = { count: 0, retired: false }
      dispatcherClaims.set(dispatcher, record)
    }
    const owned = record
    owned.count += 1
    let released = false
    return () => {
      if (released) return
      released = true
      owned.count -= 1
      if (owned.count > 0) return
      dispatcherClaims.delete(dispatcher)
      if (owned.retired) void dispatcher.close().catch(() => undefined)
    }
  }

  /** Close one dispatcher now, or as soon as the last claim on it is released. */
  const retireDispatcher = (dispatcher: DispatcherLike): void => {
    const record = dispatcherClaims.get(dispatcher)
    if (record === undefined) {
      void dispatcher.close().catch(() => undefined)
      return
    }
    record.retired = true
  }

  /**
   * Retire a whole generation of routes.
   *
   * Same rule as the single dispatcher: a route a live stream may still start a
   * request on keeps its dispatcher until that stream lets go.
   */
  const retireTable = (entries: Map<string, RouteEntry>): void => {
    for (const entry of entries.values()) retireDispatcher(entry.dispatcher)
    entries.clear()
  }

  const heartbeatStates = new Map<string, HeartbeatState>()
  /** Whether a `web` service exists, i.e. whether the reserved route has anything to carry. */
  let webAvailable = false

  /**
   * The dedicated search dispatcher, when `searchProxyStrategy` is `dedicated`
   * and a preset is bound. Not a provider route: it never enters `current`, is
   * never published as a card, and is retired by `rebuild` exactly once.
   */
  let searchDedicated: RouteEntry | undefined
  /** Why the bound search preset could not be built, when it could not. */
  let searchDedicatedProblem: string | undefined
  /**
   * The preset id `searchDedicated` was built from (`''` when there is none).
   *
   * The plan needs to know WHICH preset the live dispatcher carries: comparing
   * `profileId` against this is what stops a search made right after a binding
   * change from leaving through the preset the user just replaced.
   */
  let searchDedicatedProfileId = ''
  /**
   * Search traffic counters, kept apart from `hits` because the dashboard
   * classifies calls as `[推理]` / `[搜索]`. `hits` still counts proxied search
   * requests under the reserved id (so the card and the total stay truthful);
   * these counters additionally see the calls that never crossed a proxy.
   *
   * Counters survive a rebuild (a settings write) exactly like `hits`: they are
   * a record of what happened, not of how the traffic is currently configured.
   */
  const searchCounters = { hits: 0, proxied: 0, direct: 0, failed: 0 } as {
    hits: number
    proxied: number
    direct: number
    failed: number
  }
  let searchLast: { lastAt?: number; ok?: boolean; code?: string } = {}

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
  const lastUse = new Map<string, { startedAt: number; at?: number; ok?: boolean; code?: string; fallback?: boolean }>()
  const bump = (provider: string, token: number | undefined): void => {
    hits.set(provider, (hits.get(provider) ?? 0) + 1)
    if (routeStates.get(provider)?.token !== token) return
    // Only the START moves here. The outcome fields are written once a request
    // settles, so an in-flight call cannot overwrite the last COMPLETED result.
    lastUse.set(provider, { ...lastUse.get(provider), startedAt: Date.now() })
  }
  const settle = (provider: string, token: number | undefined) => (ok: boolean, detail: unknown, meta?: { fallback?: boolean }): void => {
    if (routeStates.get(provider)?.token !== token) return
    const previous = lastUse.get(provider)
    if (meta?.fallback && ok) {
      lastUse.set(provider, {
        startedAt: previous?.startedAt ?? Date.now(),
        at: Date.now(),
        ok: true,
        code: '[告警: 代理宕机，已降级直连]',
        fallback: true,
      })
    } else {
      lastUse.set(provider, {
        startedAt: previous?.startedAt ?? Date.now(),
        at: Date.now(),
        ok,
        code: ok ? String((detail as { status?: unknown } | undefined)?.status ?? '') : failureCodeOf(detail),
        ...(meta?.fallback ? { fallback: true } : {}),
      })
      if (ok) {
        const hb = heartbeatStates.get(provider)
        if (hb !== undefined) {
          heartbeatStates.set(provider, {
            ...hb,
            status: 'healthy',
            fails: 0,
            error: undefined,
            lastSuccessAt: Date.now(),
          })
        }
      }
    }
  }

  /**
   * Resolve the chain the next `web_search` call takes, and the payload the
   * settings page classifies calls with.
   *
   * `current` is read LIVE, so a card switched on seconds ago is already
   * visible; the dedicated dispatcher comes from the last rebuild, which is the
   * only place it can be built without leaking one per request.
   */
  const searchSplitState = (): {
    split: SearchSplitConfig
    plan: SearchPlan
    problem: string | undefined
    snapshot: SearchTrafficState
  } => {
    const split = plainSearchSplit(config)
    const profiles = plainProfiles(config)
    const profileId = split.searchProxyProfileId
    const presetExists = profileId.length > 0 && profiles[profileId] !== undefined
    /**
     * Whether the built dispatcher belongs to the preset the settings NOW name.
     *
     * `searchDedicated !== undefined` only said "some dedicated dispatcher
     * exists", not WHICH preset it was built from: after switching the binding
     * from A to B, the last rebuild's dispatcher still carried A, so a search in
     * that window left through the exit the user had just replaced — and the
     * diagnostic payload named B as the profileId next to A's endpoint.
     */
    const presetReady = searchDedicated !== undefined && searchDedicatedProfileId === profileId
    const plan = resolveSearchPlan({
      strategy: split.searchProxyStrategy,
      profileId,
      cardAvailable: current.has(WEB_SEARCH_KEY),
      presetExists,
      presetReady,
      bypassAll: plainBypassAll(config),
    })
    /**
     * A blocked plan has two very different causes, and the page must not name
     * the wrong one:
     *  - the bound preset is missing or does not BUILD (a configuration error);
     *  - the dispatcher is simply still the PREVIOUS preset's, i.e. the settings
     *    write landed before the rebuild that would replace it. That is a
     *    transient state, and the call is REFUSED rather than carried by the
     *    preset the user just replaced.
     */
    const pendingBinding =
      plan.kind === 'blocked' && searchDedicatedProblem === undefined && presetExists
    const problem =
      plan.kind === 'blocked'
        ? pendingBinding
          ? '搜索分流配置正在生效，请稍后重试'
          : // The operator-facing wording first: it names the preset and says the
            // call is REFUSED rather than leaked direct. The builder's own text
            // (`provider "search-split" …`) is the fallback, not the message.
            (searchSplitProblem({
              strategy: split.searchProxyStrategy,
              profileId,
              presetExists,
              presetReady,
            }) ??
            searchDedicatedProblem ??
            '搜索分流配置不可用')
        : undefined
    return {
      split,
      plan,
      problem,
      snapshot: {
        strategy: split.searchProxyStrategy,
        profileId,
        plan: plan.kind,
        reason: plan.reason,
        ...(plan.kind === 'dedicated' && searchDedicated !== undefined
          ? { endpoint: searchDedicated.proxyOrigin }
          : {}),
        ...(problem === undefined ? {} : { problem }),
        ...searchCounters,
        ...searchLast,
      },
    }
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
  const MAX_CHECK_ENTRIES_PER_PROVIDER = 8
  const MAX_CHECK_PROVIDERS = 64
  const lastChecks = new Map<string, Map<string, { at: number; result: Record<string, unknown> }>>()
  /** Cache key without its provider id, so the inner map can be indexed by provider. */
  const checkKeyOf = (provider: string, key: string): string => key.slice(provider.length)

  const pruneCheckCache = (now = Date.now()): void => {
    for (const [provider, entries] of lastChecks) {
      for (const [key, entry] of entries) {
        if (now - entry.at >= SELF_CHECK_COOLDOWN_MS) entries.delete(key)
      }
      if (entries.size === 0) lastChecks.delete(provider)
    }
    while (lastChecks.size > MAX_CHECK_PROVIDERS) {
      let oldestProvider: string | undefined
      let oldestAt = Infinity
      for (const [provider, entries] of lastChecks) {
        let latest = -Infinity
        for (const entry of entries.values()) latest = Math.max(latest, entry.at)
        if (latest < oldestAt) {
          oldestAt = latest
          oldestProvider = provider
        }
      }
      if (oldestProvider === undefined) break
      lastChecks.delete(oldestProvider)
    }
  }

  const rememberCheck = (
    provider: string,
    key: string,
    result: Record<string, unknown>,
  ): void => {
    pruneCheckCache()
    let entries = lastChecks.get(provider)
    if (entries === undefined) {
      entries = new Map()
      lastChecks.set(provider, entries)
    }
    entries.set(checkKeyOf(provider, key), { at: Date.now(), result })
    while (entries.size > MAX_CHECK_ENTRIES_PER_PROVIDER) {
      let oldestKey: string | undefined
      let oldestAt = Infinity
      for (const [candidate, entry] of entries) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at
          oldestKey = candidate
        }
      }
      if (oldestKey === undefined) break
      entries.delete(oldestKey)
    }
    pruneCheckCache()
  }

  /** Drop both completed and in-flight checks for one route identity. */
  const forgetChecks = (provider: string): void => {
    lastChecks.delete(provider)
    for (const key of [...selfChecks.keys()]) {
      if (key.startsWith(`${provider}\u0000`)) selfChecks.delete(key)
    }
  }

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
  // NB: probeHeartbeatTarget (below) shares the same verdict rules — userinfo is
  // stripped before the request, a viaProxy 407 is a proxy-side failure, any
  // status < 500 counts as reachable, only 5xx (or transport errors) count as
  // failures — but it is an EARLIED background probe (HEAD → GET on 405/501,
  // 5s cap), so the two deliberately stay separate instead of parameterising a
  // shared helper. Change a shared rule here? Change it there too.
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
    // The key must describe the endpoint a request would ACTUALLY take, so a
    // route bound to a preset folds in that preset's fields — editing the
    // preset then re-checks instead of answering from a pre-edit verdict.
    const endpoint = effectiveRoute(raw, plainDefaultProxy(config), plainProfiles(config))
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
      // The emergency bypass changes whether the probe crosses the proxy at all,
      // so a verdict measured before the toggle must not answer for after it.
      plainBypassAll(config),
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
    const saved = plainProviders(config)[provider]
    const buildOptions = {
      defaultProxy: normalizeDefaultProxy(plainDefaultProxy(config)),
      profiles: plainProfiles(config),
      requireEnabled: false,
      localDirect: plainLocalDirect(config),
      bypassAll: plainBypassAll(config),
    }
    /**
     * Whether the table's route belongs to an OLDER configuration.
     *
     * The table is rebuilt on `loader/volatile-update`, which lands
     * asynchronously after a settings write. A user who saves a preset and
     * immediately clicks Test therefore hits the PREVIOUS configuration's
     * dispatcher, and a probe carried by a still-working OLD proxy answers
     * 401/200 — which reads as "the new proxy is fine" even when the newly
     * saved endpoint is a dead port. A check must never answer a question about
     * a configuration it is not using, so the live route is reused only while
     * it still matches what the settings say right now.
     *
     * The comparison is the entry's FULL check identity, not the proxy origin:
     * a credential edit, a target-host rule edit and a self-check target edit
     * all keep the same origin, and each of them changes what the check proves.
     * Comparing the origin alone made those three edits answer with the old
     * dispatcher — a fixed password still reported as a 407, a new target still
     * probed at the old one — even though the origin check was the fix for the
     * same race on the endpoint itself.
     */
    if (route !== undefined) {
      const expectedIdentity =
        saved === undefined
          ? undefined
          : routeCheckIdentity(
              effectiveRoute(
                saved,
                plainDefaultProxy(config),
                plainProfiles(config),
              ),
              buildOptions.localDirect,
            )
      if (expectedIdentity === undefined || liveCheckIdentities.get(provider) !== expectedIdentity) {
        route = undefined
      }
    }
    if (route === undefined) {
      // No usable route in the table. Rather than quote the problem the last
      // rebuild RECORDED, re-validate the CURRENT settings.
      //
      // `problems` is a snapshot from the last rebuild, and a recorded refusal
      // outlives the configuration that caused it: a user who half-typed a
      // password, saw the route refused, then cleared the field would still be
      // told "配置了代理密码但没有用户名" — about a password that no longer
      // exists anywhere. Building again cannot lie: the same `buildRouteEntry`
      // that produced the record produces the current verdict, so a fixed
      // setting reports fine and a broken one still names its real reason.
      const configured = saved
      if (configured === undefined) {
        return { ok: false, kind: 'no-route', error: `provider "${provider}" 未启用代理` }
      }
      // `enabled` gates ROUTING, not the check: an enabled route whose saved
      // endpoint differs from the table's is exactly the case this rebuild
      // exists for, so it is built here like a disabled one and released when
      // the check ends.
      const built = buildRouteEntry(provider, configured, buildOptions)
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
        if (outcome.ok === true) {
          heartbeatStates.set(provider, {
            status: 'healthy',
            lastCheckAt: Date.now(),
            lastSuccessAt: Date.now(),
            latencyMs: typeof outcome.ms === 'number' ? outcome.ms : null,
            fails: 0,
            error: undefined,
          })
          return { ...outcome, targetSource: source }
        }
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


  const HEARTBEAT_PROBE_TIMEOUT_MS = 5_000
  // See the matching note at probeTarget: the verdict rules are IDENTICAL (no
  // userinfo on the wire, viaProxy 407 → proxy-side failure, status < 500 →
  // reachable). The heartbeat probe (HEAD with Range fallback to GET, 5s budget,
  // no JSON body) is intentionally smaller — do not grow it into probeTarget's
  // shape; change shared rules in both or in neither.
  const probeHeartbeatTarget = async (
    target: string,
    route: RouteEntry,
  ): Promise<{ ok: boolean; latencyMs: number; error?: string }> => {
    let host: string | undefined
    try {
      host = new URL(target).hostname
    } catch {
      return { ok: false, latencyMs: 0, error: 'INVALID_URL' }
    }
    const viaProxy = route.decide(host) === 'proxy'
    const started = performance.now()
    const cleanTarget = ((): string => {
      try {
        const u = new URL(target)
        u.username = ''
        u.password = ''
        return u.toString()
      } catch {
        return target
      }
    })()
    const runProbe = async (method: string) => {
      return await undiciFetch(cleanTarget, {
        method,
        ...(viaProxy ? { dispatcher: route.dispatcher } : {}),
        signal: AbortSignal.timeout(HEARTBEAT_PROBE_TIMEOUT_MS),
        headers: method === 'GET' ? { Range: 'bytes=0-0' } : undefined,
      } as never)
    }
    try {
      let response = await runProbe('HEAD')
      if (response.status === 405 || response.status === 501) {
        void (response as any).body?.cancel().catch(() => {})
        response = await runProbe('GET')
      }
      void (response as any).body?.cancel().catch(() => {})
      const ms = Math.round(performance.now() - started)
      if (viaProxy && response.status === 407) {
        return { ok: false, latencyMs: ms, error: 'HTTP_407' }
      }
      if (response.status < 500) {
        return { ok: true, latencyMs: ms }
      }
      return { ok: false, latencyMs: ms, error: `HTTP_${response.status}` }
    } catch (error) {
      const ms = Math.round(performance.now() - started)
      const code = failureCodeOf(error)
      return { ok: false, latencyMs: ms, error: code }
    }
  }

  /**
   * The in-flight cycle, if any. Triggering while a cycle is already running returns
   * the SAME promise instead of doing nothing, so "trigger, then assert" is
   * deterministic for the test conduit — and never starts a duplicate probe burst.
   */
  let heartbeatActive: Promise<void> | undefined
  const runHeartbeatCycle = (): Promise<void> => {
    if (closed) return Promise.resolve()
    if (heartbeatActive) return heartbeatActive
    if (!plainHeartbeatEnabled(config)) return Promise.resolve()
    heartbeatActive = (async () => {
      // Yield before touching anything: the assignment to heartbeatActive completes
      // first, so the unconditional clear below can never erase a handle that is
      // still needed. The in-flight guard above guarantees we are the only runner.
      await Promise.resolve()
      try {
      const providers = plainProviders(config)
      const enabledProviders = Object.entries(providers)
        .filter(([id, p]) => p?.enabled === true && current.has(id))
        .map(([id]) => id)
      for (const id of [...heartbeatStates.keys()]) {
        if (!enabledProviders.includes(id)) {
          heartbeatStates.delete(id)
        }
      }
      if (enabledProviders.length === 0) return
      const threshold = plainHeartbeatConsecutiveFails(config)
      const CONCURRENCY = 2
      const queue = [...enabledProviders]
      const worker = async () => {
        while (queue.length > 0 && !closed) {
          const provider = queue.shift()
          if (!provider) break
          const route = current.get(provider)
          if (!route) continue
          const jitterMs = 20 + Math.floor(Math.random() * 80)
          await new Promise(r => setTimeout(r, jitterMs))
          if (closed) break
          const { targets } = selfCheckTargetsOf(provider, route.testTarget)
          const target = targets[0] ?? DEFAULT_TEST_URL
          const result = await probeHeartbeatTarget(target, route)
          if (closed) break
          const currentRecord = heartbeatStates.get(provider)
          if (result.ok) {
            heartbeatStates.set(provider, {
              status: 'healthy',
              lastCheckAt: Date.now(),
              lastSuccessAt: Date.now(),
              latencyMs: result.latencyMs,
              error: undefined,
              fails: 0,
            })
          } else {
            const fails = (currentRecord?.fails ?? 0) + 1
            const isUnreachable = fails >= threshold
            heartbeatStates.set(provider, {
              status: isUnreachable ? 'unreachable' : (currentRecord?.status ?? 'healthy'),
              lastCheckAt: Date.now(),
              lastSuccessAt: currentRecord?.lastSuccessAt,
              latencyMs: result.latencyMs,
              error: result.error,
              fails,
            })
          }
        }
      }
      const workers = Array.from({ length: Math.min(CONCURRENCY, enabledProviders.length) }, () => worker())
      await Promise.all(workers)
      } finally {
        // The in-flight guard above guarantees this is the only active cycle, so
        // the outer assignment landed before this microtask ever runs.
        heartbeatActive = undefined
      }
    })()
    return heartbeatActive
  }

  /**
   * The heartbeat timer is a PLAIN global timer, never `ctx.setInterval`.
   *
   * Cordis exposes `ctx.setInterval`/`ctx.clearInterval` as accessors over the
   * `timer` service, and this plugin only injects `llm`. Reading either property
   * therefore trips the context proxy guard — `cannot get property "timer"
   * without inject` — and that throw happens outside any listener catch, so the
   * Loader reports a fatal load failure and the Host process exits with 1. A
   * `typeof ctx?.setInterval === 'function'` probe does NOT protect against it:
   * the property READ itself is what throws. Owning the timer here keeps the
   * plugin composition-agnostic (no extra `timer` requirement) and its lifetime
   * explicit: the effect teardown in `apply` calls `stopHeartbeat`, and the
   * `unref()` below keeps an idle Host from being held alive by the probe.
   */
  let heartbeatTimer: any = null
  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const startHeartbeat = (): void => {
    // `wasRunning` is read BEFORE the stop below resets the timer: an arm from
    // null (mount with the setting persisted, or an off→on toggle) fires one
    // cycle right away, so the user sees the probe result immediately instead
    // of after a full interval. A re-arm from a running timer (any unrelated
    // volatile edit) must NOT add outbound traffic — the interval keeps
    // firing on its own schedule.
    const wasRunning = heartbeatTimer !== null
    stopHeartbeat()
    if (closed) return
    if (!plainHeartbeatEnabled(config)) return
    const intervalMs = plainHeartbeatInterval(config) * 1000
    heartbeatTimer = setInterval(() => {
      // A probe cycle must never surface as an unhandled rejection: under the
      // Loader that is a fatal Host error, not a logged warning.
      void runHeartbeatCycle().catch(() => undefined)
    }, intervalMs)
    if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
      heartbeatTimer.unref()
    }
    if (!wasRunning) {
      void runHeartbeatCycle().catch(() => undefined)
    }
  }
  const rebuild = (): Promise<void> => {
    // One snapshot feeds the table, the route-state diff and every cleanup.
    // Reading the Volatile fields more than once could mix two settings writes.
    const providers = plainProviders(config)
    const defaultProxy = plainDefaultProxy(config)
    const profiles = plainProfiles(config)
    const localDirect = plainLocalDirect(config)
    // `bypassAll` is part of the table, not only of the fetch shim: a route's own
    // `decide` is what the self-check, the heartbeat probe and the search plan ask
    // "would this go through the proxy?". Leaving it out left the probe sending
    // traffic through the very proxy the emergency switch had just bypassed, and
    // the card still reported "proxied" while real traffic went direct.
    const bypassAll = plainBypassAll(config)
    const next = createProxyTable(providers, { defaultProxy, profiles, localDirect, bypassAll })
    const previous = current
    current = next.entries
    problems = next.problems

    const configured = new Set(Object.keys(providers))
    for (const provider of [...heartbeatStates.keys()]) {
      if (!configured.has(provider) || providers[provider]?.enabled !== true) {
        heartbeatStates.delete(provider)
      }
    }
    for (const provider of [...routeStates.keys()]) {
      if (configured.has(provider)) continue
      routeStates.delete(provider)
      lastUse.delete(provider)
      forgetChecks(provider)
    }

    // One identity per configured route, replaced together with `current`: the
    // self-check compares it with the settings it is asked about, so a route
    // built before a credential / rule / target edit can never answer for the
    // edited configuration.
    const identities = new Map<string, string>()
    for (const [provider, raw] of Object.entries(providers)) {
      // Fingerprints describe the EFFECTIVE endpoint, so editing a preset a
      // route is bound to invalidates that route's token and self-check cache
      // exactly as editing its own fields would.
      const effective = effectiveRoute(raw, defaultProxy, profiles)
      const fingerprint = routeFingerprint({
        ...effective,
        localDirect,
      })
      identities.set(provider, routeCheckIdentity(effective, localDirect))
      const decision = routeStateDecision(routeStates.get(provider), {
        fingerprint,
        enabled: raw?.enabled === true,
      })
      const token = decision.token === 'new' ? nextRouteToken++ : routeStates.get(provider)!.token
      if (decision.clearLastUse) {
        lastUse.delete(provider)
        forgetChecks(provider)
      }
      routeStates.set(provider, { fingerprint, enabled: raw?.enabled === true, token })
    }
    liveCheckIdentities = identities

    // The dedicated search endpoint (N24) is a route like any other, but it is
    // NOT in the provider dictionary: it is derived from one preset. It is built
    // through the same builder a card uses, so its dispatcher, SOCKS5 TLS
    // options and target-host rules are identical — and it is retired exactly
    // the way the table retires routes, after the new one is live, so a search
    // in flight keeps a working dispatcher.
    const split = plainSearchSplit(config)
    const previousSearch = searchDedicated
    searchDedicated = undefined
    searchDedicatedProfileId = ''
    searchDedicatedProblem = undefined
    if (split.searchProxyStrategy === 'dedicated' && split.searchProxyProfileId.length > 0) {
      const built = buildRouteEntry(
        SEARCH_DEDICATED_KEY,
        { enabled: true, profileId: split.searchProxyProfileId },
        {
          defaultProxy: normalizeDefaultProxy(defaultProxy),
          profiles,
          requireEnabled: true,
          localDirect,
          bypassAll,
        },
      )
      if (built.ok) {
        searchDedicated = built.entry
        searchDedicatedProfileId = split.searchProxyProfileId
      } else searchDedicatedProblem = bareMessage(built.problem)
    }
    if (previousSearch !== undefined) {
      // Retired like a table entry: a search stream that has not issued its
      // request yet keeps the previous preset's dispatcher alive.
      retireDispatcher(previousSearch.dispatcher)
    }

    pruneCheckCache()
    // Retire the previous table only after the new one is live, so an in-flight
    // stream keeps a dispatcher that still works.
    retireTable(previous)
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

  // Mount path: a rebuild failure must not become an unhandled rejection.
  enqueueRebuild().catch(() => undefined)
  startHeartbeat()

  /**
   * The provider catalogue, read from `ctx.llm` where it is actually available.
   *
   * The browser has no LLM service in this release, so the page cannot ask for
   * this list itself. Serving it from the Host is the supported path: the
   * `webServer` service is confirmed live, and the shipped dsh-llm-retry-settings
   * registers its routes the same way.
   */
  const catalog = (): { providers: { id: string; name: string; live: boolean }[]; llmAvailable: boolean } => {
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
    return {
      providers: out,
      // Says whether the Host can actually read the registry. The page uses this
      // before auto-pruning saved routes whose provider vanished: a composition
      // with no llm service at all must never trigger destructive writes.
      llmAvailable: typeof (ctx as any)?.llm?.listProviders === 'function',
    }
  }

  /**
   * The forward proxy this Host process inherited from its environment, if any.
   *
   * Detected ONCE and cached: the process environment does not change under a
   * running Host, so re-reading it per request would only add work. Credentials
   * never leave `detectProxyEnv` — the payload carries `hadCredentials`, a
   * boolean, and nothing else derived from the userinfo.
   */
  let environmentDetected = false
  let environmentProxy: ReturnType<typeof detectProxyEnv> | undefined
  const environmentProxyOf = (): ReturnType<typeof detectProxyEnv> => {
    if (!environmentDetected) {
      environmentProxy = detectProxyEnv()
      environmentDetected = true
    }
    return environmentProxy
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
              environment: { proxy: environmentProxyOf() ?? null },
              bypassAll: plainBypassAll(config),
              problems: Object.fromEntries(
                [...problems].map(([id, message]) => [id, bareMessage(message)]),
              ),
              hits: Object.fromEntries(hits),
              lastUse: Object.fromEntries(lastUse),
              heartbeat: Object.fromEntries(heartbeatStates),
              // N24: the resolved search chain plus its counters, so the page can
              // classify calls without asking the Host again per card.
              search: searchSplitState().snapshot,
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

      // Reset hits counter.
      wctx?.webServer?.register?.({
        kind: 'exact',
        path: '/dsh-provider-proxy/reset-hits',
        handler: (_req: any, res: any) => {
          hits.clear()
          // The search counters are the same kind of record as `hits`, so the
          // one Reset button clears both; the strategy and the plan are
          // configuration, not history, and stay.
          searchCounters.hits = 0
          searchCounters.proxied = 0
          searchCounters.direct = 0
          searchCounters.failed = 0
          searchLast = {}
          const text = JSON.stringify({ ok: true })
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(text),
          })
          res.end(text)
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
              const key = `${provider}\u0000${selfCheckKey(provider)}`
              let pending = selfChecks.get(key)
              if (pending === undefined) {
                pruneCheckCache()
                const last = lastChecks.get(provider)?.get(checkKeyOf(provider, key))
                if (last !== undefined && Date.now() - last.at < SELF_CHECK_COOLDOWN_MS) {
                  send(200, { ...last.result, cached: true })
                  return
                }
                const checkToken = routeStates.get(provider)?.token
                pending = runSelfCheck(provider).then(result => {
                  // A provider deleted while its check was in flight must not
                  // resurrect a cache entry under the same id.
                  if (checkToken !== undefined && routeStates.get(provider)?.token === checkToken) {
                    rememberCheck(provider, key, result)
                  }
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
  // N24: the scope also carries `trafficType: 'search'`, and WHICH dispatcher it
  // carries is decided per call by `searchProxyStrategy` — the reserved card,
  // a preset-derived dedicated dispatcher, or the native path. The decision is
  // deferred to call time (not to mount time) so a settings write takes effect
  // on the very next search.
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
      const { plan, problem } = searchSplitState()
      const token = routeStates.get(WEB_SEARCH_KEY)?.token
      const startedAt = Date.now()
      searchCounters.hits += 1
      searchLast = { ...searchLast, lastAt: startedAt }
      /** The reserved card's last-call line, refreshed for a call that never crossed a proxy. */
      const touchSearchCard = (): void => {
        if (routeStates.get(WEB_SEARCH_KEY)?.token !== token) return
        lastUse.set(WEB_SEARCH_KEY, { ...lastUse.get(WEB_SEARCH_KEY), startedAt })
      }

      // Fail-closed: a `dedicated` binding that cannot be honoured REFUSES the
      // call instead of quietly changing the egress. A direct call would put the
      // searcher's real address on a network the user routed around, which is
      // exactly what they asked not to happen.
      if (plan.kind === 'blocked') {
        searchCounters.failed += 1
        searchLast = { lastAt: startedAt, ok: false, code: 'SEARCH_PROXY_UNAVAILABLE' }
        return Promise.reject(
          new Error(`dsh-provider-proxy: ${problem ?? '搜索分流配置不可用'}`),
        )
      }

      if (plan.kind === 'direct') {
        searchCounters.direct += 1
        touchSearchCard()
        const direct = Promise.resolve().then(() => original.call(this, request, signal)) as Promise<unknown>
        // The native path has no router scope to report through, so the outcome
        // is recorded here. `/providers` and the card's last-use line both read
        // these counters, and a search that failed must not look idle.
        void direct.then(
          (response: unknown) => {
            const status = (response as { status?: unknown } | undefined)?.status
            const ok = typeof status === 'number' ? status < 500 : true
            if (!ok) searchCounters.failed += 1
            searchLast = { lastAt: startedAt, ok, code: ok ? String(status ?? '') : String(status ?? 'ERROR') }
            settle(WEB_SEARCH_KEY, token)(ok, response, {})
          },
          (error: unknown) => {
            searchCounters.failed += 1
            searchLast = { lastAt: startedAt, ok: false, code: failureCodeOf(error) }
            settle(WEB_SEARCH_KEY, token)(false, error, {})
          },
        )
        return direct
      }

      // `dedicated` names the preset-derived entry; `card` the reserved route.
      // Both exist by construction — the plan is only produced for a route the
      // table (or the rebuild) actually carries.
      const route = plan.kind === 'dedicated' ? searchDedicated : current.get(WEB_SEARCH_KEY)
      if (route === undefined) {
        searchCounters.direct += 1
        touchSearchCard()
        return original.call(this, request, signal)
      }
      return router.run(
        {
          dispatcher: route.dispatcher,
          trafficType: 'search',
          onHit: () => {
            searchCounters.proxied += 1
            bump(WEB_SEARCH_KEY, token)
          },
          onSettle: (ok, detail, meta) => {
            if (!ok) searchCounters.failed += 1
            searchLast = {
              lastAt: startedAt,
              ok,
              code: ok
                ? String((detail as { status?: unknown } | undefined)?.status ?? '')
                : failureCodeOf(detail),
            }
            settle(WEB_SEARCH_KEY, token)(ok, detail, meta)
          },
          // The route's own target-host rules still decide (localDirect, a
          // bypassHosts match, an onlyHosts miss). A direct verdict is recorded,
          // because a search that did not use the proxy is exactly what the
          // dashboard's `[搜索]` classification must show.
          decide: (host: string | undefined) => {
            const verdict = route.decide(host)
            if (verdict === 'direct') {
              searchCounters.direct += 1
              touchSearchCard()
            }
            return verdict
          },
          enableFallbackDirect: plainEnableFallbackDirect(config),
          bypassAll: plainBypassAll(config),
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
        // The claim keeps this dispatcher alive across a settings rebuild until
        // the scope either starts its request or ends without one.
        const release = claimDispatcher(route.dispatcher)
        return router.wrap(
          {
            dispatcher: route.dispatcher,
            // N24: model calls are the other half of the split, so the scope
            // says which one it carries. A rule that ever needs to treat search
            // differently can read it without a second router.
            trafficType: 'reasoning',
            onHit: () => bump(provider, token),
            onSettle: settle(provider, token),
            decide: route.decide,
            enableFallbackDirect: plainEnableFallbackDirect(config),
            bypassAll: plainBypassAll(config),
            onLeaseRelease: release,
          },
          next as () => AsyncIterable<unknown>,
        )
      },
      { global: true },
    )

    const onConfig = (): void => {
      // enqueueRebuild() returns a REJECTED promise when rebuild() throws, and the
      // two-arg `.then` keeps that rejection from surfacing as an unhandled one —
      // the same class of error that used to take the Host down. startHeartbeat
      // must run on both paths so a rebuild failure cannot silently freeze the
      // previous timer with stale config.
      void enqueueRebuild().then(
        () => startHeartbeat(),
        () => startHeartbeat(),
      )
    }
    ctx.on('loader/volatile-update', onConfig, { global: true })

    return async () => {
      if (closed) return
      closed = true
      stop()
      stopHeartbeat()
      heartbeatStates.clear()
      await rebuildQueue.catch(() => undefined)
      await closeTable(current)
      current = new Map()
      // The dedicated search dispatcher is not part of `current`, so the table
      // close above cannot reach it; it must be released on the same teardown.
      if (searchDedicated !== undefined) {
        const dedicated = searchDedicated
        searchDedicated = undefined
        await dedicated.dispatcher.close().catch(() => undefined)
      }
      // A generation retired by an earlier rebuild may still be waiting on a
      // stream that will now never finish: dispose is the end of the line, so
      // every claim is dropped and the dispatchers are closed for real.
      for (const dispatcher of [...dispatcherClaims.keys()]) {
        void dispatcher.close().catch(() => undefined)
      }
      dispatcherClaims.clear()
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
      bypassAll: plainBypassAll(config),
      problems: Object.fromEntries(problems),
      hits: Object.fromEntries(hits),
      lastUse: Object.fromEntries(lastUse),
      heartbeat: Object.fromEntries(heartbeatStates),
      /** N24: the resolved search chain, its endpoint and its counters. */
      search: searchSplitState().snapshot,
      setHeartbeatState: (provider: string, state: HeartbeatState) => heartbeatStates.set(provider, state),
      triggerHeartbeatCycle: () => runHeartbeatCycle(),
      selfCheckCache: (() => {
        let expiredEntries = 0
        let maxPerProvider = 0
        let totalEntries = 0
        for (const entries of lastChecks.values()) {
          totalEntries += entries.size
          maxPerProvider = Math.max(maxPerProvider, entries.size)
          for (const entry of entries.values()) {
            if (Date.now() - entry.at >= SELF_CHECK_COOLDOWN_MS) expiredEntries += 1
          }
        }
        return {
          providers: lastChecks.size,
          pending: selfChecks.size,
          expiredEntries,
          totalEntries,
          maxPerProvider,
        }
      })(),
    }),
  })
}

export {
  acquireFetchRouter,
  canReplayRequest,
  kNativeFetch,
  isNetworkFailoverError,
} from './fetch-router.js'
export type { TrafficContext, TrafficType } from './fetch-router.js'
export {
  SEARCH_PROXY_STRATEGIES,
  DEFAULT_SEARCH_PROXY_STRATEGY,
  normalizeSearchSplitConfig,
  resolveSearchPlan,
  searchSplitProblem,
  type SearchPlan,
  type SearchPlanInput,
  type SearchProxyStrategy,
  type SearchSplitConfig,
} from './search-split.js'
export {
  buildDecide,
  buildRouteEntry,
  createProxyTable,
  closeTable,
  proxyUrl,
  routeFingerprint,
  routeStateDecision,
} from './proxy-table.js'
export { Config, ProviderProxyRoute, DefaultProxy, normalizeRoute, normalizeDefaultProxy, PROTOCOLS } from './config.js'
export { defaultProxyProblem, proxyHostProblem } from './proxy-address.js'
export { PROXY_CLIENT_PRESETS, proxyClientPreset } from './proxy-clients.js'
export { detectProxyEnv, parseProxyEnvValue } from './proxy-env.js'
export {
  backupCounts,
  backupFileName,
  backupOps,
  buildBackup,
  parseBackup,
  validateEnabledRoutes,
  BACKUP_VERSION,
} from './backup.js'
export {
  PROVIDER_HOST_TEMPLATES,
  appendHostRules,
  deadRuleEntries,
  hostMatches,
  hostRuleProblem,
  normalizeHostRulesText,
  parseHostList,
  providerHostTemplate,
  reinterpretedRuleEntries,
  splitHostRules,
} from './host-rules.js'
export {
  DEFAULT_PROFILE_LABEL,
  bindingFields,
  endpointSummary,
  effectiveRoute,
  profileNameProblem,
  profileNames,
  resolveEndpoint,
  routeBindingOf,
  routesBoundTo,
  withEndpoint,
} from './presets.js'

export {
  calculateCoverage,
  calculateSuccessRate,
  calculateAverageLatency,
  calculateTotalHits,
  calculateTrafficSplit,
  formatNumber,
  countUnreachableProviders,
} from './dashboard.js'
export { normalizeHeartbeatConfig, type HeartbeatConfig } from './config.js'
