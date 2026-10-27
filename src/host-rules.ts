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

/**
 * The official upstream hosts of well-known providers.
 *
 * The point is not completeness — an adapter may point anywhere — but that the
 * ONE spelling a user is likely to need is written down centrally instead of
 * being recalled from memory. Every entry is asserted to be a live rule by the
 * test suite, so a template can never introduce a dead entry; a dead `onlyHosts`
 * entry is silent and makes fail-closed send traffic direct while the user
 * believes it is proxied.
 *
 * The value is the text that goes into `onlyHosts`: bare host names and `*.`
 * wildcards only, which is exactly what `hostRuleProblem` accepts.
 */
export const PROVIDER_HOST_TEMPLATES: Readonly<
  Record<string, { label: string; hosts: string }>
> = {
  openai: { label: 'OpenAI', hosts: 'api.openai.com, *.openai.com' },
  anthropic: { label: 'Anthropic', hosts: 'api.anthropic.com' },
  google: { label: 'Google', hosts: 'generativelanguage.googleapis.com' },
  deepseek: { label: 'DeepSeek', hosts: 'api.deepseek.com' },
}

/**
 * The template for one provider id, or `undefined` when there is none.
 *
 * Provider ids in the wild carry suffixes (`openai-responses`, `deepseek-chat`)
 * and may be namespaced. The id is therefore matched on its FIRST segment when
 * split on `-`, `_`, `/`, `:` or `.`, case-insensitively — that is the part the
 * adapters share. An id that merely CONTAINS a known name in a later segment
 * (a relay called `my-openai`) is deliberately not matched: a template is a
 * guess, and a wrong guess silently narrows where traffic goes.
 */
export function providerHostTemplate(
  providerId: string,
): { id: string; label: string; hosts: string } | undefined {
  const key = providerId.trim().toLowerCase().split(/[-_/:.]/)[0] ?? ''
  const template = PROVIDER_HOST_TEMPLATES[key]
  return template === undefined ? undefined : { id: key, ...template }
}

/**
 * Append template hosts to an existing rule string, without duplicating any
 * entry the user already wrote.
 *
 * Appending rather than replacing is deliberate: a card may carry a relay host
 * of its own, and silently discarding it would break that route. Comparison is
 * on the NORMALIZED entries, so `*.openai.com` and `.openai.com` count as the
 * same rule and neither is added twice.
 */
export function appendHostRules(raw: string, hosts: string): string {
  const existing = new Set(parseHostList(raw))
  // Dedupe on the NORMALIZED rule (so `*.openai.com` and `.openai.com` are the
  // same rule) but append the TEMPLATE's own spelling, which is the text the
  // pill promised to load.
  const additions: string[] = []
  for (const token of splitHostRules(hosts)) {
    const normalized = normalizeHostRule(token)
    if (normalized.length === 0 || existing.has(normalized)) continue
    existing.add(normalized)
    additions.push(token)
  }
  if (additions.length === 0) return raw.trim()
  const prefix = raw.trim()
  return prefix.length === 0 ? additions.join(', ') : `${prefix}, ${additions.join(', ')}`
}
