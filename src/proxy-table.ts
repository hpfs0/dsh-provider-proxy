/**
 * The proxy table: one dispatcher per enabled provider.
 *
 * A dispatcher is created per provider rather than shared, so a proxied
 * provider can never leak its transport into another provider's call even when
 * both resolve to the same upstream host.
 *
 * Two transports are supported, and they come from the SAME npm undici instance
 * (the build leaves `undici` external), which is what lets both be handed to
 * `undiciFetch` by the router:
 *
 * - `http`/`https` → `ProxyAgent`, which speaks HTTP CONNECT to an HTTP proxy;
 * - `socks5`      → `Socks5ProxyAgent`, undici's built-in RFC 1928/1929 client,
 *                   which tunnels the target instead of forwarding to it.
 */

import { ProxyAgent, Socks5ProxyAgent } from 'undici'

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
 * A credential-free origin, for diagnostics only.
 *
 * `new URL(url).origin` is NOT usable for socks5: socks5 is a non-special
 * scheme, and WHATWG URL serializes the origin of a non-special scheme as the
 * string `'null'` (the same rule that made `gopher` return `'null'` in Node
 * 15). That value is surfaced verbatim in `ctx.providerProxyState` and in the
 * settings page's diagnostics, so it would hide which proxy a SOCKS5 provider
 * is using. HTTP keeps using `.origin`, which is what it already did.
 *
 * Credentials are never part of this string: it is built from host and port.
 */
function displayOrigin(route: ProviderProxyRouteValue, url: string): string {
  if (route.protocol !== 'socks5') return new URL(url).origin
  const host = route.host.includes(':') && !route.host.startsWith('[') ? `[${route.host}]` : route.host
  return `${route.protocol}://${host}:${route.port}`
}

/**
 * Build the dispatcher for one route.
 *
 * SOCKS5 authentication is passed as options rather than through the URL so the
 * password never appears in the proxy address. `Socks5ProxyAgent` also accepts
 * userinfo in the URL, but `proxyUrl()` already emits the username there for
 * the HTTP case, and the explicit option takes precedence — so the password
 * stays out of the string that is logged and reported.
 */
function createDispatcher(
  route: ProviderProxyRouteValue,
  url: string,
  password: string,
): DispatcherLike {
  if (route.protocol === 'socks5') {
    const auth: { username?: string; password?: string } = {}
    if (route.username.length > 0) auth.username = route.username
    if (password.length > 0) auth.password = password
    return new Socks5ProxyAgent(url, auth) as unknown as DispatcherLike
  }
  return new ProxyAgent({ uri: url }) as unknown as DispatcherLike
}

/**
 * Build the dispatchers for every enabled, valid route.
 *
 * Invalid routes are skipped rather than thrown: one mistyped provider must not
 * stop the others from proxying. The caller surfaces the reason through
 * `problems`, which the Client shows instead of failing the whole table.
 */
export function createProxyTable(
  config: { readonly [provider: string]: Partial<ProviderProxyRouteValue> } | undefined,
): { entries: Map<string, RouteEntry>; problems: Map<string, string> } {
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

    // A SOCKS5 username without a password must be REFUSED, not downgraded.
    //
    // undici's Socks5Client only offers USERNAME_PASSWORD when both parts are
    // present (`if (options.username && options.password)`); with a username
    // alone it quietly advertises NO_AUTH. Against a proxy that requires
    // authentication the user would then be told "Authentication failed" — a
    // wrong diagnosis pointing at the proxy rather than at the missing setting.
    if (route.protocol === 'socks5' && route.username.length > 0 && route.password.length === 0) {
      problems.set(
        provider,
        'dsh-provider-proxy: SOCKS5 配置了用户名但没有密码；请补全密码或清空用户名',
      )
      continue
    }

    const url = proxyUrl(route)
    let dispatcher: DispatcherLike
    try {
      dispatcher = createDispatcher(route, url, route.password)
    } catch (error) {
      problems.set(provider, error instanceof Error ? error.message : String(error))
      continue
    }
    entries.set(provider, { provider, proxyOrigin: displayOrigin(route, url), dispatcher })
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