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
  /** Proxy host or IP, without scheme, port, or path. */
  host: string
  /** Proxy port. 0 means "not configured". */
  port: number
}

/**
 * Why this endpoint cannot carry a request, or `undefined` when it can.
 *
 * The host and port checks mirror `normalizeRoute` exactly, so the browser's
 * verdict and the Host's are the same verdict.
 */
export function defaultProxyProblem(endpoint: ProxyEndpoint): string | undefined {
  const host = endpoint.host.trim()
  if (host.length === 0) return '未填写代理地址'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host) || host.includes('/')) {
    return '代理地址只填主机名或 IP，不要带协议前缀或路径'
  }
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
    return '代理端口无效（需为 1-65535 的整数）'
  }
  return undefined
}
