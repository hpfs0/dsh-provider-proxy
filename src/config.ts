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
 * - The proxy password never lives in this Config. `passwordRef` is only the
 *   NAME of a credential held by the credentials service; the secret itself is
 *   written through `ctx.remote.credentials.set`, the same way the Models page
 *   stores provider API keys. A `role('secret')` field would keep the value out
 *   of settings responses but would still write it into cordis.patch.yml.
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
  /** Proxy transport. `socks5` is accepted but only honoured when the socks helper loaded. */
  protocol: z.union(PROTOCOLS).default('http'),
  /** Proxy host or IP, without scheme, port, or path. */
  host: z.string().default(''),
  /** Proxy port. 0 means "not configured"; enabled routes require 1-65535. */
  port: z.number().default(0),
  /** Optional proxy username. */
  username: z.string().default(''),
  /** NAME of the credentials-service record holding the proxy password. Never the password. */
  passwordRef: z.string().default(''),
})

export const Config = z.object({
  /** Per-provider proxy routes, keyed by provider route id (e.g. `sensenova`). */
  providers: vol(z.dict(ProviderProxyRoute).default({})),
})

export interface ProviderProxyRouteValue {
  enabled: boolean
  protocol: Protocol
  host: string
  port: number
  username: string
  passwordRef: string
}

export interface ConfigShape {
  providers: { readonly [provider: string]: ProviderProxyRouteValue }
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
): ProviderProxyRouteValue {
  const route = ProviderProxyRoute(raw ?? {})
  const value = typeof (route as { get?: () => unknown }).get === 'function'
    ? (route as unknown as { get: () => ProviderProxyRouteValue }).get()
    : (route as ProviderProxyRouteValue)

  if (!value.enabled) return { ...value, port: value.port || 0 }

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
  return { ...value, host, username: value.username.trim() }
}