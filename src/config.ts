/**
 * Plugin Config.
 *
 * Shape notes, all verified against DeepSeek Harness 0.2.0-rc.2:
 *
 * - `schemastery` is NOT guaranteed to be resolvable from a profile-hoisted
 *   install, so the real package is preferred at runtime when `createRequire`
 *   can see it and a bundled fallback is used otherwise. The reference plugin
 *   `dsh-llm-retry-settings` does exactly this.
 * - Every editable field is `.volatile()` so a settings write is committed
 *   into the running fiber WITHOUT remounting the plugin; the Host then
 *   rebuilds its proxy table. Ordinary (non-volatile) fields would restart the
 *   plugin instead, which is not what a settings page wants.
 * - The SOCKS5 proxy password lives directly on the route as `password`, so the
 *   settings page writes it into cordis.patch.yml in the clear. It is only ever
 *   handed to `Socks5ProxyAgent` as an option, never embedded in the proxy URL
 *   that is logged or shown in the diagnostics.
 */

import { createRequire } from 'node:module'

// Imported statically so the bundler inlines it, making the package
// self-contained. `loadSchemastery` below still PREFERS the profile's own copy
// when one is reachable, so a DSH-provided instance stays authoritative; this
// bundled copy is only the fallback that lets the plugin load at all.
import * as BundledSchema from '@deepseek-ai/schemastery'

type SchemaLike = {
  object: (...args: any[]) => any
  string: (...args: any[]) => any
  boolean: (...args: any[]) => any
  number: (...args: any[]) => any
  dict: (...args: any[]) => any
  union: (...args: any[]) => any
}

/**
 * Resolve the schemastery module for this fiber.
 *
 * A profile installation hoists dependencies next to the profile rather than
 * under this package, so a bare `import` can fail even when the Host itself
 * uses schemastery. `createRequire` resolves against this file's real
 * location, which is the best available view of the installation tree.
 *
 * When that finds nothing — a plain `npm install` of this package, which pulls
 * no schemastery — the BUNDLED copy is used, so the plugin still loads instead
 * of throwing at require time.
 */
function loadSchemastery(): SchemaLike {
  try {
    const require = createRequire(import.meta.url)
    const candidate = require('@deepseek-ai/schemastery')
    const live = (candidate as { default?: SchemaLike })?.default ?? (candidate as SchemaLike)
    if (live && typeof live.object === 'function') return live
  } catch {
    // Fall through to the bundled copy below.
  }
  // The static import is only a fallback; what it actually exposes is decided at
  // runtime, which this structural type deliberately does not pin.
  const bundled = (BundledSchema as { default?: unknown }).default ?? BundledSchema
  if (typeof (bundled as SchemaLike).object === 'function') return bundled as SchemaLike
  throw new Error('dsh-provider-proxy: no usable @deepseek-ai/schemastery in this installation')
}

const z = loadSchemastery()

/** Apply `.volatile()` when the resolved schemastery supports it. */
function vol<T>(field: T): T {
  const volatile = (field as { volatile?: () => unknown }).volatile
  return typeof volatile === 'function' ? (volatile.call(field) as T) : field
}

/** Forward-compatible passthrough for schemastery extensions used below. */
function stepMin<T extends { step?: (n: number) => T; min?: (n: number) => T }>(field: T, step?: number): T {
  let out = field
  if (step !== undefined && typeof out.step === 'function') out = out.step(step)
  return out
}

/** Supported forward-proxy transports. */
export const PROTOCOLS = ['http', 'https', 'socks5'] as const
export type Protocol = (typeof PROTOCOLS)[number]

/**
 * The shared endpoint a route may opt into with `useDefault`.
 *
 * There is deliberately NO `enabled` flag here: a default is "configured" when
 * it has a host and an in-range port, and nothing else. A second switch would
 * create the state "default configured but switched off", from which every route
 * that opted in would silently lose its proxy — a failure mode with no upside,
 * because a route opts in individually with `useDefault` and can be switched off
 * on its own card.
 */
export const DefaultProxy = z.object({
  protocol: z.union(PROTOCOLS).default('http'),
  /** Proxy host or IP, without scheme, port, or path. */
  host: z.string().default(''),
  /** Proxy port. 0 means "not configured". */
  port: z.number().default(0),
  username: z.string().default(''),
  password: z.string().default(''),
})

/**
 * One provider's proxy settings. Keyed by provider route id.
 *
 * `port` is deliberately NOT constrained by schemastery's min/max: an unset
 * proxy is `0` (meaning "no port chosen yet"), and a bound of 1 here would make
 * that default fail to parse. The real range check lives in `normalizeRoute`,
 * which runs only when a route is actually enabled, so the error can name the
 * provider instead of surfacing a bare schema path.
 */
export const ProviderProxyRoute = z.object({
  /** Whether this provider's calls are routed through the proxy below. */
  enabled: z.boolean().default(false),
  /**
   * When true, this route's TRANSPORT fields (protocol/host/port/username/
   * password) come from the top-level `defaultProxy` instead of its own, so the
   * same endpoint is configured once for every provider that shares it. The
   * target-host rules and the self-check target stay the route's own. There is
   * no partial inheritance: to use a different endpoint, turn this off and fill
   * the fields in.
   */
  useDefault: z.boolean().default(false),
  /** Proxy transport. `socks5` is accepted but only honoured when the socks helper loaded. */
  protocol: z.union(PROTOCOLS).default('http'),
  /** Proxy host or IP, without scheme, port, or path. */
  host: z.string().default(''),
  /** Proxy port. 0 means "not configured"; enabled routes require 1-65535. */
  port: z.number().default(0),
  /** Optional proxy username. */
  username: z.string().default(''),
  /** SOCKS5 proxy password. Only used when `protocol` is `socks5`. */
  password: z.string().default(''),
  /**
   * Comma/space-separated TARGET hosts that must go through the proxy. Empty
   * means "no restriction" (every target is proxied). Suffix match.
   */
  onlyHosts: z.string().default(''),
  /** Comma/space-separated TARGET hosts that bypass the proxy; takes priority over `onlyHosts`. */
  bypassHosts: z.string().default(''),
  /**
   * Optional self-check target for THIS provider's 测试 button. Empty falls back
   * to the top-level `testUrl`. Only the self-check reads it; routing never
   * touches it, so a bad value costs a failed check, never a broken route.
   */
  testTarget: z.string().default(''),
})

export const Config = z.object({
  /** Per-provider proxy routes, keyed by provider route id (e.g. `sensenova`). */
  providers: vol(z.dict(ProviderProxyRoute).default({})),
  /**
   * Shared endpoint for every route that sets `useDefault`. Volatile for the
   * same reason as `providers`: a settings write is committed into the running
   * fiber instead of remounting the plugin.
   */
  defaultProxy: vol(DefaultProxy.default({})),
  /**
   * Whether a loopback/private-address target is sent DIRECT instead of through
   * the proxy. On by default: such a target is normally a relay on this very
   * machine (LiteLLM, Ollama, a local mock), which a forward proxy cannot reach
   * at all — forcing it through one fails, and the failure reads as "the proxy
   * is broken". Turn this off only when the proxy itself is the target.
   */
  localDirect: vol(z.boolean().default(true)),
  /**
   * URL the per-provider connection self-check requests THROUGH the proxy.
   * Volatile, so a settings write does not remount the plugin; the default is an
   * IP echo service, which lets the check report the exit address.
   */
  testUrl: vol(z.string().default('https://api.ipify.org?format=json')),
})

export interface ProviderProxyRouteValue {
  enabled: boolean
  useDefault: boolean
  protocol: Protocol
  host: string
  port: number
  username: string
  password: string
  onlyHosts: string
  bypassHosts: string
  testTarget: string
}

/** The normalized shared endpoint; see {@link DefaultProxy}. */
export interface DefaultProxyValue {
  protocol: Protocol
  host: string
  port: number
  username: string
  password: string
}

export interface ConfigShape {
  providers: { readonly [provider: string]: ProviderProxyRouteValue }
  defaultProxy: DefaultProxyValue
  localDirect: boolean
  testUrl: string
}

/** Read a schemastery-parsed object's plain value, whichever shape it takes. */
function plain<T>(parsed: unknown): T {
  const get = (parsed as { get?: () => unknown }).get
  return (typeof get === 'function' ? get.call(parsed) : parsed) as T
}

/**
 * Normalize the shared default endpoint. Mirrors {@link normalizeRoute} so both
 * the Host and a test can hand `createProxyTable` a raw object.
 *
 * Format is validated lazily, exactly like a route: a malformed default costs a
 * `problems` entry naming each route that opted into it, never a crash.
 */
export function normalizeDefaultProxy(raw: Partial<DefaultProxyValue> | undefined): DefaultProxyValue {
  const value = plain<DefaultProxyValue>(DefaultProxy(raw ?? {}))
  return {
    protocol: value.protocol,
    host: value.host.trim(),
    port: value.port,
    username: value.username.trim(),
    password: value.password,
  }
}

/**
 * Validate one route and return the normalized value, or throw with a
 * field-scoped message. Used by both the Host (before opening a dispatcher)
 * and the settings form (before writing), so an invalid value never reaches
 * disk or the network.
 */
export function normalizeRoute(
  provider: string,
  raw: Partial<ProviderProxyRouteValue> | undefined,
  options?: { requireEnabled?: boolean },
): ProviderProxyRouteValue {
  const value = plain<ProviderProxyRouteValue>(ProviderProxyRoute(raw ?? {}))

  // Host rules are stored normalized (trimmed, lower-cased) so the matcher built
  // from them never re-parses on the hot path. WHATWG URL already lower-cases a
  // hostname, so both sides of the comparison agree.
  const onlyHosts = value.onlyHosts.trim().toLowerCase()
  const bypassHosts = value.bypassHosts.trim().toLowerCase()
  const testTarget = value.testTarget.trim()

  // A disabled route is normally returned untouched: nothing has been asked of
  // it, so a half-typed endpoint must not be reported as a problem. The
  // self-check DOES ask — it builds a dispatcher for a route the user has not
  // switched on yet — so it passes `requireEnabled: false` to get exactly the
  // validation routing would apply once the route is on.
  if (!value.enabled && options?.requireEnabled !== false) {
    return { ...value, port: value.port || 0, onlyHosts, bypassHosts, testTarget }
  }

  const host = value.host.trim()
  if (host.length === 0) {
    throw new TypeError(`dsh-provider-proxy: provider "${provider}" 启用了代理，但未填写代理地址`)
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host) || host.includes('/')) {
    throw new TypeError(`dsh-provider-proxy: provider "${provider}" 的代理地址只填主机名或 IP，不要带协议前缀或路径`)
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new TypeError(
      `dsh-provider-proxy: provider "${provider}" 的代理端口无效（需为 1-65535 的整数）`,
    )
  }
  return { ...value, host, username: value.username.trim(), onlyHosts, bypassHosts, testTarget }
}