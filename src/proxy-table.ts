/**
 * The proxy table: one dispatcher per enabled provider.
 *
 * A dispatcher is created per provider rather than shared, so a proxied
 * provider can never leak its transport into another provider's call even when
 * both resolve to the same upstream host.
 */

import { ProxyAgent } from 'undici'

import { normalizeRoute, type ProviderProxyRouteValue } from './config.js'
import type { DispatcherLike } from './fetch-router.js'

export interface RouteEntry {
  provider: string
  /** Normalized proxy origin, for diagnostics only. Never logged with credentials. */
  proxyOrigin: string
  dispatcher: DispatcherLike
}

function proxyUrl(route: ProviderProxyRouteValue): string {
  const auth =
    route.username.length === 0
      ? ''
      : `${encodeURIComponent(route.username).replace(/%3A/gi, ':')}@`
  // IPv6 literals need brackets in a URL authority.
  const host = route.host.includes(':') && !route.host.startsWith('[') ? `[${route.host}]` : route.host
  return `${route.protocol}://${auth}${host}:${route.port}`
}

/**
 * Build the dispatchers for every enabled, valid route.
 *
 * Invalid routes are skipped rather than thrown: one mistyped provider must not
 * stop the others from proxying. The caller surfaces the reason through
 * `problems`, which the Client shows instead of failing the whole table.
 */
export async function createProxyTable(
  config: { readonly [provider: string]: Partial<ProviderProxyRouteValue> } | undefined,
  options: { resolvePassword?: (provider: string, ref: string) => string | undefined } = {},
): Promise<{ entries: Map<string, RouteEntry>; problems: Map<string, string> }> {
  const entries = new Map<string, RouteEntry>()
  const problems = new Map<string, string>()

  for (const [provider, raw] of Object.entries(config ?? {})) {
    let route: ProviderProxyRouteValue
    try {
      route = normalizeRoute(provider, raw)
    } catch (error) {
      problems.set(provider, error instanceof Error ? error.message : String(error))
      continue
    }
    if (!route.enabled) continue

    if (route.protocol === 'socks5') {
      // undici's ProxyAgent speaks HTTP CONNECT to an HTTP proxy only; a SOCKS5
      // endpoint needs a custom connector. Reported, never silently mis-routed.
      problems.set(provider, 'dsh-provider-proxy: socks5 暂未实现，请改用 http 或 https')
      continue
    }

    const password = options.resolvePassword?.(provider, route.passwordRef)
    void password // Reserved: credentials are injected as a header, never in the URL.

    const url = proxyUrl(route)
    let dispatcher: DispatcherLike
    try {
      dispatcher = new ProxyAgent({ uri: url }) as unknown as DispatcherLike
    } catch (error) {
      problems.set(provider, error instanceof Error ? error.message : String(error))
      continue
    }
    entries.set(provider, { provider, proxyOrigin: new URL(url).origin, dispatcher })
  }

  return { entries, problems }
}

/** Close every dispatcher, ignoring individual failures. */
export async function closeTable(entries: Map<string, RouteEntry>): Promise<void> {
  const closing = [...entries.values()].map(entry => entry.dispatcher.close().catch(() => undefined))
  await Promise.allSettled(closing)
  entries.clear()
}

export { proxyUrl }