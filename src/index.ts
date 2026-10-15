/**
 * dsh-provider-proxy — Host half.
 *
 * Routes the model calls of the providers the user enabled through that
 * provider's own forward proxy. Every other provider, and all other DSH
 * traffic, keeps using the normal network path.
 */

import { fetch as undiciFetch } from 'undici'

import { acquireFetchRouter } from './fetch-router.js'
import { closeTable, createProxyTable, type RouteEntry } from './proxy-table.js'
import type { ProviderProxyRouteValue } from './config.js'

export const name = 'dsh-provider-proxy'
export const inject = ['llm']

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

export function apply(ctx: any, config?: ProxyConfig): void {
  const router = acquireFetchRouter()
  let current = new Map<string, RouteEntry>()
  let problems = new Map<string, string>()
  let closed = false

  // Request counts, keyed by provider id. Held OUTSIDE the proxy table so a
  // rebuild (a settings write) never resets them; only a plugin reload does.
  // Counted at request initiation — see fetch-router.ts.
  const hits = new Map<string, number>()
  const bump = (provider: string): void => {
    hits.set(provider, (hits.get(provider) ?? 0) + 1)
  }

  /** Where the self-check sends its request; overridable so a blocked echo host can be replaced. */
  const DEFAULT_TEST_URL = 'https://api.ipify.org?format=json'
  const TEST_TIMEOUT_MS = 10_000
  /** One in-flight check per provider, so a repeated click cannot multiply outbound requests. */
  const selfChecks = new Map<string, Promise<Record<string, unknown>>>()

  /** Read `testUrl`, which is Volatile under the Loader and therefore needs `.get()`. */
  const plainTestUrl = (): string => {
    const raw = (config as { testUrl?: unknown } | undefined)?.testUrl
    const snapshot = (raw as { get?: () => unknown } | undefined)?.get
    const value = typeof snapshot === 'function' ? snapshot.call(raw) : raw
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : DEFAULT_TEST_URL
  }

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

  /** Classify a self-check failure so the report points at the hop that actually failed. */
  const classifyTestError = (error: unknown): { kind: string; error: string } => {
    const chain = causesOf(error)
    const names = chain
      .map(node => (node as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string')
    const codes = chain
      .map(node => (node as { code?: unknown }).code)
      .filter((code): code is string => typeof code === 'string')
    const message = error instanceof Error ? error.message : String(error)
    if (names.includes('TimeoutError') || names.includes('AbortError')) {
      return { kind: 'timeout', error: `超时（${TEST_TIMEOUT_MS / 1000}s）：代理或目标无响应` }
    }
    const connectivity = ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN']
    const code = connectivity.find(candidate => codes.includes(candidate))
    if (code !== undefined) {
      return { kind: 'proxy-unreachable', error: `代理不可达（${code}）：${message}` }
    }
    if (names.includes('ProxyAuthentication') || message.includes('407')) {
      return { kind: 'proxy-auth', error: `代理要求认证（HTTP 407）：${message}` }
    }
    return { kind: 'target', error: `请求失败：${message}` }
  }

  /**
   * Send one request through a provider's OWN dispatcher and report the outcome.
   *
   * The dispatcher is passed EXPLICITLY rather than by entering the router's
   * AsyncLocalStorage scope: that scope intercepts `globalThis.fetch`, so a plain
   * `undici.fetch` call would go straight out and report a broken proxy as a
   * success — the one failure this whole feature exists to eliminate.
   */
  const runSelfCheck = async (provider: string): Promise<Record<string, unknown>> => {
    const route = current.get(provider)
    if (route === undefined) {
      return { ok: false, kind: 'no-route', error: `provider "${provider}" 未启用代理` }
    }
    const started = performance.now()
    try {
      const response = await undiciFetch(plainTestUrl(), {
        dispatcher: route.dispatcher,
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      } as never)
      const ms = Math.round(performance.now() - started)
      // 407 is the proxy demanding credentials: a RESULT, not a throw.
      if (response.status === 407) {
        return { ok: false, ms, status: 407, kind: 'proxy-auth', error: '代理要求认证（HTTP 407）' }
      }
      let exitIp: string | undefined
      try {
        const body = (await response.json()) as { ip?: unknown } | null
        if (typeof body?.ip === 'string' && body.ip.length > 0) exitIp = body.ip
      } catch {
        // A non-JSON echo still proves the request crossed the proxy.
      }
      return {
        ok: response.ok === true,
        ms,
        status: response.status,
        ...(exitIp === undefined ? {} : { exitIp }),
        kind: response.ok === true ? 'ok' : 'target',
      }
    } catch (error) {
      return { ok: false, ms: Math.round(performance.now() - started), ...classifyTestError(error) }
    }
  }

  // One line on activation so a user can tell "mounted" from "not mounted" in
  // the Host log without guessing. Never prints a credential.
  try {
    ctx.logger.info('dsh-provider-proxy mounted (pid %d)', process.pid)
  } catch {
    // A context without a logger still works; the diagnostics getter remains.
  }

  const rebuild = async (): Promise<void> => {
    const next = createProxyTable(plainProviders(config))
    const previous = current
    current = next.entries
    problems = next.problems
    // Retire the previous table only after the new one is live, so an in-flight
    // stream keeps a dispatcher that still works.
    void closeTable(previous)
  }

  const ready = rebuild()

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
              problems: Object.fromEntries(problems),
              hits: Object.fromEntries(hits),
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
          const send = (status: number, payload: unknown): void => {
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
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('error', () => send(400, { ok: false, kind: 'body', error: '读取请求体失败' }))
          req.on('end', () => {
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
              let pending = selfChecks.get(provider)
              if (pending === undefined) {
                pending = runSelfCheck(provider)
                selfChecks.set(provider, pending)
                void pending.finally(() => {
                  if (selfChecks.get(provider) === pending) selfChecks.delete(provider)
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

  ctx.effect(() => {
    const stop = ctx.on(
      'llm/stream',
      (options: { provider?: string }, next: () => AsyncIterable<unknown>) => {
        const provider = options?.provider
        if (typeof provider !== 'string') return next()
        const route = current.get(provider)
        if (route === undefined) return next()
        // The stream is consumed lazily; wrap it so the scope survives. The hit
        // counter rides inside the scope, so an abandoned stream still counts.
        return router.wrap(
          {
            dispatcher: route.dispatcher,
            provider,
            onHit: () => bump(provider),
            decide: route.decide,
          },
          next as () => AsyncIterable<unknown>,
        )
      },
      { global: true },
    )

    const onConfig = (): void => {
      void rebuild()
    }
    ctx.on('loader/volatile-update', onConfig, { global: true })

    return async () => {
      stop()
      if (closed) return
      closed = true
      await ready.catch(() => undefined)
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
    }),
  })
}

export { acquireFetchRouter } from './fetch-router.js'
export { createProxyTable, closeTable, proxyUrl } from './proxy-table.js'
export { Config, ProviderProxyRoute, normalizeRoute, PROTOCOLS } from './config.js'