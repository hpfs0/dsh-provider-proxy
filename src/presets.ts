/**
 * Named proxy presets, shared by the Host and the settings page.
 *
 * A preset is a named copy of the transport fields that already exist on
 * `DefaultProxy`. Keeping the resolution rule HERE — rather than re-deriving it
 * in the table, the self-check key and the browser — is what keeps "which
 * endpoint does this card actually use" answerable in exactly one way.
 *
 * Backward compatibility is the reason the top-level `defaultProxy` is not
 * migrated into `proxyProfiles`: a 0.8.0 file has no `proxyProfiles` key at all,
 * and its routes keep resolving through `useDefault` untouched. The default
 * endpoint is merely DISPLAYED as the built-in preset "默认预设 (Default)".
 */

import type { DefaultProxyValue, ProviderProxyRouteValue } from './config.js'

/** Preset dictionary as it arrives from settings (every value may be partial). */
export type ProfileMap = Readonly<Record<string, Partial<DefaultProxyValue> | undefined>>

/** The built-in preset name. Never stored as a key in `proxyProfiles`. */
export const DEFAULT_PROFILE_LABEL = '默认预设 (Default)'

/**
 * The `<select>` value that means "the built-in default preset".
 *
 * A select needs one flat value per option, so the two bindings that are not a
 * named preset get fixed sentinels. This one is RESERVED: `profileNameProblem`
 * refuses it as a name, so it can never collide with a preset the user creates.
 */
export const DEFAULT_PROFILE_BINDING = '__default__'

/**
 * Which endpoint a route points at.
 *
 * `own` and `default` are exactly the 0.8.0 states; `profile` is new. `own`
 * keeps the route's own transport fields, `default` borrows `defaultProxy`, and
 * `profile` borrows one named preset.
 */
export type RouteBinding =
  | { kind: 'own' }
  | { kind: 'default' }
  | { kind: 'profile'; profileId: string }

/**
 * Resolve the binding of one route.
 *
 * A non-empty `profileId` always wins, even if `useDefault` is still true: the
 * page clears `useDefault` when the user picks a preset, but a hand-edited file
 * may carry both, and "the field the user just filled" is the safer winner.
 */
export function routeBindingOf(
  route: Partial<ProviderProxyRouteValue> | undefined,
): RouteBinding {
  const profileId = (route?.profileId ?? '').trim()
  if (profileId.length > 0) return { kind: 'profile', profileId }
  if (route?.useDefault === true) return { kind: 'default' }
  return { kind: 'own' }
}

/** The two route fields that together express one binding, for a settings write. */
export function bindingFields(binding: RouteBinding): {
  profileId: string
  useDefault: boolean
} {
  switch (binding.kind) {
    case 'profile':
      return { profileId: binding.profileId, useDefault: false }
    case 'default':
      return { profileId: '', useDefault: true }
    case 'own':
      return { profileId: '', useDefault: false }
  }
}

/** One resolved endpoint, or why the route cannot be built with its binding. */
export type EndpointResolution =
  | { ok: true; binding: RouteBinding; endpoint?: Partial<DefaultProxyValue> }
  | { ok: false; binding: RouteBinding; problem: string }

/**
 * Resolve the endpoint a route's transport fields come from.
 *
 * `own` carries no endpoint: the route's own fields are used as-is. A missing
 * preset is an ERROR rather than a fallback to the route's own (usually empty)
 * fields — falling back would silently route through nothing while the card
 * still claimed to be using a preset.
 */
export function resolveEndpoint(
  provider: string,
  route: Partial<ProviderProxyRouteValue> | undefined,
  defaultProxy: Partial<DefaultProxyValue> | undefined,
  profiles: ProfileMap | undefined,
): EndpointResolution {
  const binding = routeBindingOf(route)
  if (binding.kind === 'own') return { ok: true, binding }
  if (binding.kind === 'default') return { ok: true, binding, endpoint: defaultProxy ?? {} }
  const preset = profiles?.[binding.profileId]
  if (preset === undefined) {
    return {
      ok: false,
      binding,
      problem: `dsh-provider-proxy: provider "${provider}" 绑定的预设「${binding.profileId}」不存在；请选择一个现有预设或改用自定义配置`,
    }
  }
  return { ok: true, binding, endpoint: preset }
}

/** Normalize a preset name, or explain why it cannot be used. */
export function profileNameProblem(raw: string): string | undefined {
  const name = raw.trim()
  if (name.length === 0) return '预设名称不能为空'
  if (name.length > 40) return '预设名称不能超过 40 个字符'
  // A control character cannot be typed into a settings key meaningfully and
  // would make the dictionary entry impossible to reference from the UI.
  if (/[\u0000-\u001f\u007f]/.test(name)) return '预设名称不能包含控制字符'
  if (name === DEFAULT_PROFILE_LABEL) return '该名称由内置默认预设保留，请换一个名称'
  if (name === DEFAULT_PROFILE_BINDING) return '该名称由插件保留，请换一个名称'
  return undefined
}

/**
 * A route whose TRANSPORT fields have been replaced by one endpoint.
 *
 * Only transport moves: `onlyHosts`/`bypassHosts`/`testTarget` belong to the
 * provider's traffic, not to the proxy, so they stay the route's own.
 */
export function withEndpoint(
  route: Partial<ProviderProxyRouteValue>,
  endpoint: Partial<DefaultProxyValue>,
): Partial<ProviderProxyRouteValue> {
  return {
    ...route,
    protocol: endpoint.protocol ?? 'http',
    host: endpoint.host ?? '',
    port: endpoint.port ?? 0,
    username: endpoint.username ?? '',
    password: endpoint.password ?? '',
  }
}

/**
 * The route as it will actually be built, for fingerprinting and diagnostics.
 *
 * An unresolvable binding (a deleted preset) yields the route unchanged: the
 * table records a problem for it, and pretending it had an endpoint would make
 * the card look configured.
 */
export function effectiveRoute(
  route: Partial<ProviderProxyRouteValue> | undefined,
  defaultProxy: Partial<DefaultProxyValue> | undefined,
  profiles: ProfileMap | undefined,
): Partial<ProviderProxyRouteValue> {
  const base = route ?? {}
  const binding = routeBindingOf(base)
  if (binding.kind === 'own') return base
  const resolved = resolveEndpoint('', base, defaultProxy, profiles)
  if (!resolved.ok || resolved.endpoint === undefined) return base
  return withEndpoint(base, resolved.endpoint)
}

/** Every preset name, sorted for stable rendering. */
export function profileNames(profiles: ProfileMap | undefined): string[] {
  return Object.keys(profiles ?? {}).sort((a, b) => a.localeCompare(b))
}

/** Every route id currently bound to one preset. */
export function routesBoundTo(
  routes: Readonly<Record<string, Partial<ProviderProxyRouteValue> | undefined>> | undefined,
  profileId: string,
): string[] {
  const out: string[] = []
  for (const [id, route] of Object.entries(routes ?? {})) {
    if ((route?.profileId ?? '').trim() === profileId) out.push(id)
  }
  return out.sort()
}

/** A short, credential-free endpoint summary, e.g. `http://127.0.0.1:7890`. */
export function endpointSummary(endpoint: Partial<DefaultProxyValue> | undefined): string {
  const protocol = endpoint?.protocol ?? 'http'
  const host = (endpoint?.host ?? '').trim() || '—'
  const port = endpoint?.port ?? 0
  return `${protocol}://${host}:${port === 0 ? '—' : port}`
}

/**
 * A very short endpoint summary for a picker option, e.g. `127.0.0.1:7890`.
 *
 * The protocol is deliberately omitted: every option in the picker comes from
 * this plugin and the card shows the full origin underneath once it is chosen.
 * What a user needs while CHOOSING is the address, because that is what tells
 * the four local clients apart.
 */
export function endpointAddress(endpoint: Partial<DefaultProxyValue> | undefined): string {
  const host = (endpoint?.host ?? '').trim()
  const port = endpoint?.port ?? 0
  if (host.length === 0 || port === 0) return '未配置'
  return `${host}:${port}`
}
