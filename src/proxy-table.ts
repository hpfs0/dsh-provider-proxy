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
  type DefaultProxyValue,
  type ProviderProxyRouteValue,
} from './config.js'
import { hostMatches, normalizeHostRule, parseHostList } from './host-rules.js'
import { defaultProxyProblem } from './proxy-address.js'
import { resolveEndpoint, withEndpoint, type ProfileMap } from './presets.js'
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

/** The routing inputs that make one route's `lastUse` meaningful. */
export interface RouteFingerprintInput {
  enabled?: boolean
  useDefault?: boolean
  protocol?: string
  host?: string
  port?: number
  username?: string
  password?: string
  onlyHosts?: string
  bypassHosts?: string
  localDirect?: boolean
}

/** Stable, non-secret representation of the rule set in one route. */
function normalizedRuleSet(raw: string | undefined): string[] {
  const rules = (raw ?? '')
    .split(/[,\s]+/)
    .map(normalizeHostRule)
    .filter(entry => entry.length > 0)
  return [...new Set(rules)].sort()
}

/**
 * A pure fingerprint of everything that decides where a route's traffic goes.
 *
 * `enabled` and the self-check target are deliberately absent: switching a route
 * off does not invalidate its last result, and a probe URL cannot change real
 * traffic. Host-rule lists are ordered SETS, so reordering or deduplicating a
 * list must not clear the card's health record.
 */
export function routeFingerprint(input: RouteFingerprintInput): string {
  return JSON.stringify([
    input.protocol ?? 'http',
    String(input.host ?? '').trim(),
    input.port ?? 0,
    String(input.username ?? '').trim(),
    input.password ?? '',
    normalizedRuleSet(input.onlyHosts),
    normalizedRuleSet(input.bypassHosts),
    input.localDirect !== false,
  ])
}

export interface RouteState {
  fingerprint: string
  enabled: boolean
  token: number
}

/**
 * Whether a config diff allocates a fresh token and/or clears `lastUse`.
 *
 * Kept pure so the token rules can be tested without a dispatcher or a live
 * config. The caller owns the global monotonically increasing token counter.
 */
export function routeStateDecision(
  previous: Pick<RouteState, 'fingerprint' | 'enabled' | 'token'> | undefined,
  next: Pick<RouteState, 'fingerprint' | 'enabled'>,
): { token: 'new' | 'keep'; clearLastUse: boolean } {
  if (previous === undefined) return { token: 'new', clearLastUse: false }
  if (previous.fingerprint !== next.fingerprint) return { token: 'new', clearLastUse: true }
  if (previous.enabled !== next.enabled) return { token: 'new', clearLastUse: false }
  return { token: 'keep', clearLastUse: false }
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
 * Whether a target host is loopback or on a private network.
 *
 * Such a target is almost always a relay running on the same machine (LiteLLM,
 * Ollama, a local mock), which a forward proxy cannot reach at all — forcing it
 * through one fails, and the failure reads as "the proxy is broken". Sending it
 * direct is the only answer that can work.
 *
 * Matched by ADDRESS, not by the domain-suffix matcher above: `192.168.1.5` is
 * not a suffix of anything, so `hostMatches` cannot express these rules.
 */
function isLocalHost(host: string): boolean {
  // WHATWG URL keeps an IPv6 literal bracketed (`[::1]`), so strip first.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true
  if (bare === '::1') return true

  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare)
  if (octets === null) return false
  const [a, b, c, d] = octets.slice(1).map(Number)
  if (a > 255 || b > 255 || c > 255 || d > 255) return false
  if (a === 127) return true // 127.0.0.0/8 — loopback
  if (a === 10) return true // 10.0.0.0/8 — private
  if (a === 192 && b === 168) return true // 192.168.0.0/16 — private
  if (a === 169 && b === 254) return true // 169.254.0.0/16 — link-local
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12 — private
  return false
}

/**
 * Build the proxy/direct decision for one route.
 *
 * FAIL-CLOSED: an enabled route proxies by default, and only explicit exceptions
 * send a request direct — a loopback/private target (when `localDirect` is on),
 * a `bypassHosts` match, and an `onlyHosts` list that does not cover the target.
 * A target whose host cannot be parsed (`undefined`) stays on the proxy, so a
 * malformed URL cannot quietly leak a credentialed request.
 */
function buildDecide(
  route: ProviderProxyRouteValue,
  localDirect: boolean,
): (host: string | undefined) => 'proxy' | 'direct' {
  const only = parseHostList(route.onlyHosts)
  const bypass = parseHostList(route.bypassHosts)
  return host => {
    if (host === undefined) return 'proxy'
    if (localDirect && isLocalHost(host)) return 'direct'
    if (hostMatches(host, bypass)) return 'direct'
    if (only.length > 0 && !hostMatches(host, only)) return 'direct'
    return 'proxy'
  }
}

/** One built route, or the reason it could not be built. */
export type RouteBuildResult =
  | { ok: true; entry: RouteEntry }
  | { ok: false; problem: string }

/** Everything one route's build needs beyond its own settings. */
export interface RouteBuildOptions {
  /** The shared endpoint, already normalized. */
  defaultProxy: DefaultProxyValue
  /**
   * Named presets a route may bind with `profileId`. Partial values are
   * normalized here, exactly like the shared default.
   */
  profiles?: ProfileMap
  /**
   * Forwarded to `normalizeRoute`. The table passes `true` — it skips a disabled
   * route before building it — while the self-check passes `false` to get exactly
   * the validation routing would apply once the route is switched on.
   */
  requireEnabled: boolean
  /** Whether loopback/private targets are sent direct; see {@link buildDecide}. */
  localDirect: boolean
}

/**
 * Build one route entry, or explain why it cannot be built.
 *
 * Shared by the routing table and the connection self-check ON PURPOSE: the
 * check must run the exact validations routing runs, or it would report a route
 * healthy that the table refuses — the false positive this whole feature exists
 * to eliminate.
 */
export function buildRouteEntry(
  provider: string,
  raw: Partial<ProviderProxyRouteValue>,
  options: RouteBuildOptions,
): RouteBuildResult {
  let effective = raw
  // A route bound to a preset, or opted into the shared endpoint, takes its
  // proxy address from there. Checked BEFORE the merge so a refusal names the
  // setting the user actually has to fix — the preset or the default block —
  // instead of the card's empty fields.
  const resolved = resolveEndpoint(provider, raw, options.defaultProxy, options.profiles)
  if (!resolved.ok) return { ok: false, problem: resolved.problem }
  if (resolved.binding.kind === 'profile') {
    const preset = resolved.endpoint ?? {}
    // The SAME predicate the default block uses: a preset is one endpoint, and
    // a half-filled credential in it must refuse every card that binds it, with
    // a message that points at the preset.
    const why = defaultProxyProblem(preset)
    if (why !== undefined) {
      return {
        ok: false,
        problem: `dsh-provider-proxy: provider "${provider}" 绑定的预设「${resolved.binding.profileId}」不可用：${why}`,
      }
    }
    effective = withEndpoint(raw, normalizeDefaultProxy(preset))
  } else if (resolved.binding.kind === 'default') {
    const why = defaultProxyProblem(options.defaultProxy)
    if (why !== undefined) {
      return {
        ok: false,
        problem: `dsh-provider-proxy: provider "${provider}" 启用了「使用默认代理」，但顶层默认代理不可用：${why}`,
      }
    }
    // Only the TRANSPORT fields move; `onlyHosts`/`bypassHosts`/`testTarget` stay
    // the route's own, because they describe that provider's traffic, not the
    // proxy. The merge happens AFTER the endpoint is proven usable, so a route
    // can never be silently downgraded to its own (empty) fields while the user
    // believes it is using the default.
    effective = withEndpoint(raw, options.defaultProxy)
  }

  let route: ProviderProxyRouteValue
  try {
    route = normalizeRoute(provider, effective, { requireEnabled: options.requireEnabled })
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) }
  }

  // A SOCKS5 username without a password must be REFUSED, not downgraded.
  //
  // undici's Socks5Client only offers USERNAME_PASSWORD when both parts are
  // present (`if (options.username && options.password)`); with a username
  // alone it quietly advertises NO_AUTH. Against a proxy that requires
  // authentication the user would then be told "Authentication failed" — a
  // wrong diagnosis pointing at the proxy rather than at the missing setting.
  if (route.protocol === 'socks5' && route.username.length > 0 && route.password.length === 0) {
    return {
      ok: false,
      problem: 'dsh-provider-proxy: SOCKS5 配置了用户名但没有密码；请补全密码或清空用户名',
    }
  }

  // The mirror of the rule above, for the same reason: undici only offers
  // USERNAME_PASSWORD when BOTH parts are present, so a lone password is worse
  // than useless — the client advertises NO_AUTH. The tunnel would succeed
  // against an open proxy and fail against the one the credential was entered
  // for, which reads as "the password is wrong" when it was never sent.
  if (route.protocol === 'socks5' && route.password.length > 0 && route.username.length === 0) {
    return {
      ok: false,
      problem: 'dsh-provider-proxy: SOCKS5 配置了密码但没有用户名；请补全用户名或清空密码',
    }
  }

  // An HTTP/HTTPS password WITHOUT a username is refused outright: basic auth
  // cannot send a password alone, and silently dropping it would leave the user
  // believing a credential is in use when it is not. This is the symmetric
  // counterpart of the SOCKS5 guard above and lives on the same `problems`
  // path, so both mistakes are reported the same way.
  if (route.protocol !== 'socks5' && route.password.length > 0 && route.username.length === 0) {
    return {
      ok: false,
      problem: 'dsh-provider-proxy: 配置了代理密码但没有用户名；请补全用户名或清空密码',
    }
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
    return {
      ok: false,
      problem: 'dsh-provider-proxy: 配置了代理用户名但没有密码；请补全密码或清空用户名',
    }
  }

  const url = proxyUrl(route)
  let dispatcher: DispatcherLike
  try {
    dispatcher = createDispatcher(route, url, route.password)
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) }
  }
  return {
    ok: true,
    entry: {
      provider,
      proxyOrigin: displayOrigin(route, url),
      dispatcher,
      decide: buildDecide(route, options.localDirect),
      testTarget: route.testTarget,
    },
  }
}

/** Everything the table build needs beyond the routes themselves. */
export interface ProxyTableOptions {
  /** The shared endpoint a route may opt into with `useDefault`. */
  defaultProxy?: Partial<DefaultProxyValue>
  /** Named presets a route may bind with `profileId`. */
  profiles?: ProfileMap
  /**
   * Whether a loopback/private target is sent direct instead of through the
   * proxy. Defaults to true; `undefined`/absent means "on".
   */
  localDirect?: boolean
}

/**
 * Build the dispatchers for every enabled, valid route.
 *
 * Invalid routes are skipped rather than thrown: one mistyped provider must not
 * stop the others from proxying. The caller surfaces the reason through
 * `problems`, which the Client shows instead of failing the whole table.
 *
 * Only an ENABLED route is carried — and, consequently, only an enabled route
 * is ever refused: a route nobody has switched on has not asked for anything
 * yet, so a half-typed endpoint on it is not a problem to report. The self-check
 * is what makes a disabled route buildable on demand.
 */
export function createProxyTable(
  config: { readonly [provider: string]: Partial<ProviderProxyRouteValue> } | undefined,
  options: ProxyTableOptions = {},
): { entries: Map<string, RouteEntry>; problems: Map<string, string> } {
  const entries = new Map<string, RouteEntry>()
  const problems = new Map<string, string>()
  const buildOptions: RouteBuildOptions = {
    defaultProxy: normalizeDefaultProxy(options.defaultProxy),
    profiles: options.profiles,
    requireEnabled: true,
    localDirect: options.localDirect !== false,
  }

  for (const [provider, raw] of Object.entries(config ?? {})) {
    if (raw?.enabled !== true) continue
    const built = buildRouteEntry(provider, raw, buildOptions)
    if (!built.ok) problems.set(provider, built.problem)
    else entries.set(provider, built.entry)
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
