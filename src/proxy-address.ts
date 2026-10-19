/**
 * The proxy-endpoint usability predicate, in ONE place.
 *
 * This lives in its own module — free of Node and schemastery imports — so the
 * BROWSER half can import the very same rule the Host applies. It exists because
 * the browser used to keep its own weaker copy that checked only "host non-empty
 * and port in range": against `https://1.2.3.4` that copy lit the default block
 * green and enabled the bulk "use the default" button, while the Host refused
 * every route that pointed at it (a host carrying a scheme or path is rejected by
 * `normalizeRoute`). One predicate, imported by both halves, cannot disagree
 * with itself.
 */
export interface ProxyEndpoint {
  /**
   * Proxy host or IP, without scheme, port, or path.
   *
   * Optional because the browser calls this with whatever the settings document
   * currently holds, which mid-edit is not yet a complete endpoint.
   */
  host?: string
  /** Proxy port. 0 means "not configured". */
  port?: number
  /**
   * Credential parts, if the endpoint carries any. A HALF-filled pair is a
   * problem, the same way it is on the route itself — see below.
   */
  username?: string
  password?: string
}

/**
 * Why this endpoint cannot carry a request, or `undefined` when it can.
 *
 * The host and port checks mirror `normalizeRoute` exactly, so the browser's
 * verdict and the Host's are the same verdict. The credential pairing check
 * mirrors the guards in `buildRouteEntry`, which is what makes this predicate a
 * truthful preview of whether a route that opts into the default will actually be
 * built: without it, a default carrying `alice` and no password lit the block
 * green and enabled the bulk button, and every card it pointed at was then
 * refused by the credential guard with `entries.size === 0`.
 *
 * Tolerates a partial object (`{}`, `host: undefined`) rather than throwing: the
 * browser calls this with whatever the settings document currently holds, which
 * during a half-typed edit is not yet a complete endpoint.
 */
export function defaultProxyProblem(endpoint: ProxyEndpoint): string | undefined {
  const host = (endpoint.host ?? '').trim()
  if (host.length === 0) return '未填写代理地址'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host) || host.includes('/')) {
    return '代理地址只填主机名或 IP，不要带协议前缀或路径'
  }
  // `?? 0` rather than a throw: an absent port is "not configured", which is the
  // same thing 0 already means everywhere else in this plugin.
  const port = endpoint.port ?? 0
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return '代理端口无效（需为 1-65535 的整数）'
  }
  // "Both or neither", exactly as `buildRouteEntry` enforces per transport. The
  // wording stays transport-neutral here because the default block carries a
  // protocol the user may still change; the route-level guards spell out the
  // protocol-specific reason once it is pinned.
  const hasUser = (endpoint.username ?? '').length > 0
  const hasPassword = (endpoint.password ?? '').length > 0
  if (hasUser !== hasPassword) {
    return hasUser
      ? '配置了代理用户名但没有密码；请补全密码或清空用户名'
      : '配置了代理密码但没有用户名；请补全用户名或清空密码'
  }
  return undefined
}
