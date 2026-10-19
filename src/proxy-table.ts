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

import {
  normalizeDefaultProxy,
  normalizeRoute,
  usableDefaultProxy,
  type DefaultProxyValue,
  type ProviderProxyRouteValue,
} from './config.js'
import type { DispatcherLike } from './fetch-router.js'

export interface RouteEntry {
  provider: string
  /** Normalized proxy origin, for diagnostics only. Never logged with credentials. */
  proxyOrigin: string
  dispatcher: DispatcherLike
  /** Whether one request's target host goes through the proxy or stays direct. */
  decide: (host: string | undefined) => 'proxy' | 'direct'
  /**
   * This route's self-check target: a URL, or '' to use the top-level `testUrl`.
   * Only the self-check reads it; a bad value fails a check, never a route.
   */
  testTarget: string
}

function proxyUrl(route: ProviderProxyRouteValue): string {
  // A colon in the username stays percent-encoded (%3A), never rewritten to a
  // literal ':'. A WHATWG URL splits userinfo at the FIRST literal colon, so a
  // literal one coming from a name like `a:b` would be misread as the password
  // separator (`a` + password `b`); keeping it encoded is exactly what lets
  // undici's decodeURIComponent restore the real name. Earlier code rewrote %3A
  // back to ':' — that was subtly wrong.
  //
  // HTTP/HTTPS carry credentials in the userinfo, which undici turns into a
  // Proxy-Authorization header. SOCKS5 embeds the USERNAME only: its password is
  // handed to Socks5ProxyAgent as an option, so it never enters this string (nor
  // the credential-free origin derived from it).
  const credentials =
    route.username.length === 0
      ? ''
      : route.password.length > 0 && route.protocol !== 'socks5'
        ? `${encodeURIComponent(route.username)}:${encodeURIComponent(route.password)}@`
        : `${encodeURIComponent(route.username)}@`
  // IPv6 literals need brackets in a URL authority.
  const host = route.host.includes(':') && !route.host.startsWith('[') ? `[${route.host}]` : route.host
  return `${route.protocol}://${credentials}${host}:${route.port}`
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
 * Split a host-rule string into matchable entries.
 *
 * Entries are separated by commas or whitespace. A leading `.` or `*.` is
 * dropped — both spellings mean the same suffix match as a bare host — and the
 * whole string was already lower-cased by `normalizeRoute`, so matching is
 * case-insensitive on both sides.
 */
function parseHostList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map(entry => entry.trim().replace(/^\*?\./, ''))
    .filter(entry => entry.length > 0)
}

/**
 * Whether a host is covered by one rule list.
 *
 * `*` matches everything; otherwise a rule matches the host itself or any
 * subdomain of it (`example.com` covers `api.example.com`).
 */
function hostMatches(host: string, rules: readonly string[]): boolean {
  for (const rule of rules) {
    if (rule === '*') return true
    if (host === rule || host.endsWith(`.${rule}`)) return true
  }
  return false
}

/**
 * Build the proxy/direct decision for one route.
 *
 * FAIL-CLOSED: an enabled route proxies by default, and only two things send a
 * request direct — a `bypassHosts` match, and an `onlyHosts` list that does not
 * cover the target. A target whose host cannot be parsed (`undefined`) stays on
 * the proxy, so a malformed URL cannot quietly leak a credentialed request.
 */
function buildDecide(route: ProviderProxyRouteValue): (host: string | undefined) => 'proxy' | 'direct' {
  const only = parseHostList(route.onlyHosts)
  const bypass = parseHostList(route.bypassHosts)
  return host => {
    if (host === undefined) return 'proxy'
    if (hostMatches(host, bypass)) return 'direct'
    if (only.length > 0 && !hostMatches(host, only)) return 'direct'
    return 'proxy'
  }
}

/**
 * Apply the shared default endpoint to one route that opted into it.
 *
 * Only the TRANSPORT fields move; `onlyHosts`/`bypassHosts`/`testTarget` stay the
 * route's own, because they describe that provider's traffic, not the proxy. The
 * merge happens AFTER the endpoint is proven usable, so a route can never be
 * silently downgraded to its own (empty) fields while the user believes it is
 * using the default.
 */
function withDefaultProxy(
  route: Partial<ProviderProxyRouteValue>,
  defaultProxy: DefaultProxyValue,
): Partial<ProviderProxyRouteValue> {
  return {
    ...route,
    protocol: defaultProxy.protocol,
    host: defaultProxy.host,
    port: defaultProxy.port,
    username: defaultProxy.username,
    password: defaultProxy.password,
  }
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
  defaultProxy?: Partial<DefaultProxyValue>,
): { entries: Map<string, RouteEntry>; problems: Map<string, string> } {
  const entries = new Map<string, RouteEntry>()
  const problems = new Map<string, string>()
  const shared = normalizeDefaultProxy(defaultProxy)

  for (const [provider, rawConfig] of Object.entries(config ?? {})) {
    let raw = rawConfig
    // A route that opted into the shared endpoint takes the proxy address from
    // it. That address is validated HERE rather than being merged and left to
    // fail the route's own check, so the refusal names the setting the user
    // actually has to fix (the default block, not the card).
    if (raw?.enabled === true && raw?.useDefault === true) {
      if (!usableDefaultProxy(shared)) {
        problems.set(
          provider,
          `dsh-provider-proxy: provider "${provider}" 启用了「使用默认代理」，但顶层默认代理未配置（需填写主机与 1-65535 的端口）`,
        )
        continue
      }
      raw = withDefaultProxy(raw, shared)
    }
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

    // The mirror of the rule above, for the same reason: undici only offers
    // USERNAME_PASSWORD when BOTH parts are present, so a lone password is worse
    // than useless — the client advertises NO_AUTH. The tunnel would succeed
    // against an open proxy and fail against the one the credential was entered
    // for, which reads as "the password is wrong" when it was never sent.
    if (route.protocol === 'socks5' && route.password.length > 0 && route.username.length === 0) {
      problems.set(
        provider,
        'dsh-provider-proxy: SOCKS5 配置了密码但没有用户名；请补全用户名或清空密码',
      )
      continue
    }

    // An HTTP/HTTPS password WITHOUT a username is refused outright: basic auth
    // cannot send a password alone, and silently dropping it would leave the user
    // believing a credential is in use when it is not. This is the symmetric
    // counterpart of the SOCKS5 guard above and lives on the same `problems`
    // path, so both mistakes are reported the same way.
    if (route.protocol !== 'socks5' && route.password.length > 0 && route.username.length === 0) {
      problems.set(
        provider,
        'dsh-provider-proxy: 配置了代理密码但没有用户名；请补全用户名或清空密码',
      )
      continue
    }

    // The mirror for HTTP/HTTPS, where the asymmetry is worth spelling out:
    // undici WOULD send `Basic base64("alice:")` — a username with an EMPTY
    // password — so nothing is dropped and a lenient proxy accepts it. It is
    // refused anyway, because a half-filled credential is nearly always a
    // half-typed one, and "both or neither" is one rule to hold across all three
    // transports instead of "the pairing each transport happens to carry". The
    // cost is real and documented in the README: a proxy whose credential truly
    // has an empty password cannot be configured here.
    if (route.protocol !== 'socks5' && route.username.length > 0 && route.password.length === 0) {
      problems.set(
        provider,
        'dsh-provider-proxy: 配置了代理用户名但没有密码；请补全密码或清空用户名',
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
    entries.set(provider, {
      provider,
      proxyOrigin: displayOrigin(route, url),
      dispatcher,
      decide: buildDecide(route),
      testTarget: route.testTarget,
    })
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