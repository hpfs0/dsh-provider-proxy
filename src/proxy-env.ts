/**
 * Detect a forward proxy from the Host process environment.
 *
 * The settings page offers this as a convenience: a user who already runs a
 * proxy through `HTTP_PROXY` / `ALL_PROXY` should not have to retype the same
 * address into a field. Only the ADDRESS is used — never the credentials —
 * because this value is published over a same-origin HTTP endpoint and must not
 * become a credential exfiltration path. A credential is reported as a BOOLEAN
 * so the page can say "the variable had a password, please re-enter it".
 *
 * Parsing is deliberately dependency-free and tolerant: an env var may be a
 * bare `host:port` (the spelling V2Ray exports) or a full URL, and a bad value
 * must not throw at Host startup.
 */

import type { Protocol } from './config.js'

export interface DetectedProxy {
  /** Which environment variable the endpoint came from. */
  source: 'HTTPS_PROXY' | 'HTTP_PROXY' | 'ALL_PROXY'
  protocol: Protocol
  host: string
  port: number
  /** Whether the variable carried a credential that was dropped. */
  hadCredentials: boolean
}

/** Variables to inspect, in priority order (the first usable one wins). */
const SOURCES = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'] as const

/** The explicit `:port` written in the text, or 0 when there is none. */
function explicitPortOf(text: string): number {
  const authority = text.slice(text.indexOf('://') + 3).split(/[/?#]/, 1)[0] ?? ''
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  const match = /^\[[^\]]+\]:(\d+)$/.exec(hostPort) ?? /^[^:]+:(\d+)$/.exec(hostPort)
  if (match === null) return 0
  const parsed = Number.parseInt(match[1], 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Parse one proxy environment value into an endpoint.
 *
 * Returns `undefined` for anything that is not a usable forward proxy, so a
 * malformed variable is skipped instead of being published as a broken preset.
 */
export function parseProxyEnvValue(
  raw: string | undefined,
): Omit<DetectedProxy, 'source'> | undefined {
  const text = (raw ?? '').trim()
  if (text.length === 0) return undefined

  // An env var may carry several URLs separated by commas (curl's convention);
  // only the first is used, which is also the one curl would try first.
  const first = text.split(',')[0]?.trim() ?? ''
  if (first.length === 0) return undefined

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `http://${first}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return undefined
  }

  const scheme = url.protocol.slice(0, -1).toLowerCase()
  // `socks://` is a common alias this plugin does not accept on its own.
  const protocol: Protocol | undefined =
    scheme === 'socks'
      ? 'socks5'
      : scheme === 'http' || scheme === 'https' || scheme === 'socks5'
        ? (scheme as Protocol)
        : undefined
  if (protocol === undefined) return undefined

  const host =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname
  if (host.length === 0) return undefined

  // WHATWG URL drops a DEFAULT port for http/https, so `http://proxy:80` would
  // come back port-less. The original text is consulted so an explicitly written
  // :80/:443 is preserved, while an absent port stays 0 ("not configured").
  const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : explicitPortOf(withScheme)
  return {
    protocol,
    host,
    port: Number.isNaN(port) ? 0 : port,
    hadCredentials: url.username.length > 0 || url.password.length > 0,
  }
}

/**
 * The first usable proxy in `env`, or `undefined` when there is none.
 *
 * A variable whose endpoint has no usable port is skipped: it cannot build a
 * dispatcher, and publishing it would only produce a preset that is refused.
 */
export function detectProxyEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DetectedProxy | undefined {
  for (const source of SOURCES) {
    const parsed = parseProxyEnvValue(env[source])
    if (parsed === undefined) continue
    if (parsed.port < 1 || parsed.port > 65535) continue
    return { source, ...parsed }
  }
  return undefined
}
