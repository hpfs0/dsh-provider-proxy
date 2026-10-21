/**
 * Target-host rule parsing shared by the Host matcher and the settings page.
 *
 * This module deliberately has no undici import: the browser bundle imports it
 * too, and the two halves must agree on what an entry means before either can
 * safely warn about an entry that will never match.
 */

/** Split a host-rule string into raw, non-empty tokens. */
export function splitHostRules(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
}

/**
 * Normalize one raw rule for suffix matching.
 *
 * A leading `.` or `*.` is dropped: both spellings mean "this host and its
 * subdomains". Lower-casing belongs here as well, because the Host compares
 * against a WHATWG hostname that is already lower-cased.
 */
export function normalizeHostRule(raw: string): string {
  return raw.trim().replace(/^\*?\./, '').toLowerCase()
}

/** Split and normalize a host-rule string into matchable entries. */
export function parseHostList(raw: string): string[] {
  return splitHostRules(raw)
    .map(normalizeHostRule)
    .filter(entry => entry.length > 0)
}

/**
 * Whether a host is covered by one rule list.
 *
 * `*` matches everything; otherwise a rule matches the host itself or any
 * subdomain of it (`example.com` covers `api.example.com`).
 */
export function hostMatches(host: string, rules: readonly string[]): boolean {
  for (const rule of rules) {
    if (rule === '*') return true
    if (host === rule || host.endsWith(`.${rule}`)) return true
  }
  return false
}

/** Whether a raw token is a bracketed IPv6 literal, e.g. `[::1]`. */
function isBracketedIpv6(token: string): boolean {
  return /^\[[0-9a-f:.]+\]$/i.test(token)
}

/** Whether a raw token can never match the Host's hostname comparison. */
export function hostRuleProblem(raw: string): string | undefined {
  const token = raw.trim()
  if (token.length === 0) return undefined
  // A bare `*.` normalizes to an empty string and disappears from the match
  // list entirely; report it rather than silently accepting a no-op.
  if (token === '*.' || normalizeHostRule(token).length === 0) return '空通配符'
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return '带协议前缀'
  if (token.includes('/')) return '带路径'
  // Host compares hostnames, never `host:port`; a bracketed IPv6 literal is the
  // one legitimate colon in a hostname.
  if (token.includes(':') && !isBracketedIpv6(token)) return '带端口或非法冒号'
  // Host strips only a leading `.`/`*.`; any other `*` cannot be a hostname.
  const withoutLeadingWildcard = token.replace(/^\*\./, '')
  if (withoutLeadingWildcard.includes('*') && token !== '*') return '杂散通配符'
  return undefined
}

/** Every raw token that will never match, in the order it was typed. */
export function deadRuleEntries(raw: string): string[] {
  return splitHostRules(raw).filter(entry => hostRuleProblem(entry) !== undefined)
}
