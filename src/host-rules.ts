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
    // The full-width comma (U+FF0C) is what an IME produces when a user types a
    // list in a Chinese keyboard, and it used to glue two rules into one dead
    // token: `example.com，api.example.com` matched NEITHER host while the page
    // showed no warning at all. Any Unicode whitespace splits too.
    .split(/[,\uFF0C\s]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
}

/**
 * Normalize one raw rule for suffix matching.
 *
 * A leading `.` or `*.` is dropped: both spellings mean "this host and its
 * subdomains". REPEATED prefixes are dropped as well (`..foo`, `*.*.foo`), a
 * trailing dot — which only spells an absolute DNS name — is removed, and
 * doubled interior dots are collapsed. None of those spellings can change which
 * host a rule means, and none of them can be matched literally, so resolving them
 * here is what makes the page's verdict and the Host's behaviour the same answer.
 * Lower-casing belongs here as well, because the Host compares against a WHATWG
 * hostname that is already lower-cased.
 *
 * A bare `*` is deliberately left alone: it is the "match everything" rule, not
 * an empty prefix. `.*` and `*.*` normalize to `*` for the same reason.
 */
export function normalizeHostRule(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:\*\.|\.)+/, '')
    .replace(/\.+$/, '')
    .replace(/\.{2,}/g, '.')
    .toLowerCase()
}

/** Split and normalize a host-rule string into matchable entries. */
export function parseHostList(raw: string): string[] {
  return splitHostRules(raw)
    .map(normalizeHostRule)
    .filter(entry => entry.length > 0)
}

/**
 * The canonical text of one rule list, in the spelling the matcher will read.
 *
 * Used where a rule list is normalized before it is stored (`normalizeRoute`), so
 * the Host never compares against a rule that means something else than the one
 * the user typed. Dead entries are KEPT verbatim: dropping one would quietly
 * widen the list (`onlyHosts` with a single dead entry means "proxy nothing",
 * not "proxy everything").
 */
export function normalizeHostRulesText(raw: string): string {
  return parseHostList(raw).join(', ')
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
  // Judge the NORMALIZED spelling, i.e. exactly what the matcher will compare.
  // Reading the raw token instead is what reported `.*` and `*.*` as dead while
  // they matched EVERY host — the page promised "this entry never matches" and
  // the Host executed "bypass everything", which is the opposite of the truth.
  const rule = normalizeHostRule(token)
  // A bare `*.` normalizes to an empty string and disappears from the match
  // list entirely; report it rather than silently accepting a no-op.
  if (rule.length === 0) return '空通配符'
  // `*`, `.*` and `*.*` all mean "everything": a live rule, not a stray wildcard.
  if (rule === '*') return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rule)) return '带协议前缀'
  if (rule.includes('/')) return '带路径'
  // Host compares hostnames, never `host:port`; a bracketed IPv6 literal is the
  // one legitimate colon in a hostname.
  if (rule.includes(':') && !isBracketedIpv6(rule)) return '带端口或非法冒号'
  // The leading `*.` is already gone, so any remaining `*` cannot be a hostname.
  if (rule.includes('*')) return '杂散通配符'
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
