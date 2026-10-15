/**
 * dsh-provider-proxy — Host half.
 *
 * Routes the model calls of the providers the user enabled through that
 * provider's own forward proxy. Every other provider, and all other DSH
 * traffic, keeps using the normal network path.
 */

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