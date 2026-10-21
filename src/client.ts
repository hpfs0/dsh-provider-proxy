/**
 * dsh-provider-proxy — browser half.
 *
 * Contributes ONE settings page (a `settings.section` list entry) that lists
 * every known provider with its proxy switch, type, host, port and username.
 *
 * This replaces an earlier attempt to render into each provider card on the
 * Models page (`settings.models.provider-card`). That seat is keyed and
 * dispatched per provider namespace, and a third-party registration never
 * matched it on this build: no error, no request, simply no output. A
 * `settings.section` entry is a plain list contribution with an `id`, which is
 * the shape the shipped `dsh-llm-retry-settings` plugin uses successfully in
 * this same desktop profile.
 *
 * The whole bundle runs inside the client module system's lazy-CJS factory:
 * executing the script only REGISTERS the factory, and every side effect
 * (including the CSS injection) happens at materialization.
 */

// The CSS-Modules build turns this sheet into a hashed class map AND injects it
// at materialization. The binding is what the component reads; importing it for
// side effects only would leave `styles` undefined at render time.
import styles from './client.css'
import { defaultProxyProblem, proxyHostProblem } from './proxy-address.js'

type Protocol = 'http' | 'https' | 'socks5'

type RouteValue = {
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

/** The provider rows we know about, and which of them are actually live. */
type ProviderRow = { id: string; name: string; live: boolean }

/**
 * React, resolved from the client module table.
 *
 * React is NOT a Cordis service and is not reachable from `ctx` — reading it
 * there produced a silently null component. The module table is the only route:
 * the build leaves `react` external, so this compiles to a `require("react")`
 * inside the factory closure, answered from the shell-seeded baseline.
 *
 * Resolved lazily on first render so merely REGISTERING the bundle — which is
 * all a script evaluation does — never materializes React.
 */
let ReactCache: unknown

function react(): any {
  if (ReactCache === undefined) {
    ReactCache = ((): unknown => {
      try {
        return require('react')
      } catch {
        return (globalThis as Record<string, unknown>).React
      }
    })()
  }
  return ReactCache
}

const PROTOCOLS: Protocol[] = ['http', 'https', 'socks5']

/** Our own settings namespace; the profile entry id created by the bundle patch. */
const NAMESPACE = 'provider-proxy'

/**
 * Cordis services this half needs.
 *
 * ONLY `slots` is declared. That is the complete set this release actually
 * offers on a client fiber: `layout, locale, sessions, slots, theme, timer,
 * uiWorkspace, workspaces`.
 *
 * A declared service that never arrives leaves the fiber PENDING forever, and
 * that is NOT a client-only failure — it is reported as
 *   web boot: 1 entry did not activate
 *   dsh-provider-proxy: pending (waiting for service: settingsScope)
 * which fails the whole Desktop boot. `settingsScope` and `configForms` were
 * both guessed and both are absent here, so neither may be declared.
 *
 * Settings are therefore reached through `ctx.get(name)` — the framework's own
 * non-throwing lookup — and the page degrades to read-only when it is absent.
 */
const PLUGINS = ['slots']

export const inject = PLUGINS

export function apply(ctx: any): void {
  // The settings shell declares `settings.section` on its own fiber, so
  // `slots.inject` waits for that declaration and the contribution is removed
  // when the panel is torn down.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: NAMESPACE,
        order: 20,
        label: () => 'Provider 代理',
      },
      () => renderPage(ctx),
    ),
  )
}

/**
 * Pick the dictionary.
 *
 * Chinese is the default, not English: this plugin is written for a
 * Chinese-speaking operator, and a page that renders in the wrong language is
 * worse than one that never matches the shell's locale.
 *
 * `ctx.locale` is not injected — declaring a service that this release does not
 * provide left the fiber PENDING and failed the whole Desktop boot — so the
 * locale is probed with the non-throwing `ctx.get`, then the browser's own
 * language, and only then English.
 */
function localeOf(ctx: any): string {
  try {
    const service = optionalService(ctx, 'locale')
    const snapshot = service?.getSnapshot?.() ?? service?.getLocale?.()
    const id = typeof snapshot?.locale === 'string' ? snapshot.locale : undefined
    if (id !== undefined) return id.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    // fall through to the browser language
  }
  const browser = globalThis.navigator?.language
  if (typeof browser === 'string' && browser.toLowerCase().startsWith('zh')) return 'zh'
  return browser === undefined ? 'zh' : 'en'
}

/**
 * Look a service up WITHOUT declaring it in `inject`.
 *
 * `ctx.get(name)` is the framework's own optional lookup: it returns undefined
 * instead of throwing, and — unlike a declared service — it cannot leave the
 * fiber PENDING. That is what makes an optional integration safe here: this
 * release has no settings service at all, so the page simply shows its fields
 * and reports that saving is unavailable.
 */
function optionalService(ctx: any, ...names: string[]): any {
  for (const name of names) {
    try {
      const found = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
      if (found !== undefined && found !== null) return found
    } catch {
      // try the next spelling
    }
  }
  return undefined
}

/** The settings form for this plugin's namespace, when one exists. */
function formOf(ctx: any): any {
  const forms = optionalService(ctx, 'configForms', 'settingsScope')
  if (forms === undefined) return undefined
  try {
    if (typeof forms.get === 'function') return forms.get(NAMESPACE)
    // A settingsScope-style service is already bound to one namespace.
    if (typeof forms.getSnapshot === 'function' || typeof forms.bind === 'function') return forms
  } catch {
    return undefined
  }
  return undefined
}

function readConfig(ctx: any): { value: any; revision: number } {
  const form = formOf(ctx)
  if (form === undefined) return { value: {}, revision: 0 }
  try {
    const snapshot = form.getSnapshot?.()
    return {
      value: snapshot?.value ?? snapshot?.user ?? {},
      revision: snapshot?.revision ?? 0,
    }
  } catch {
    return { value: {}, revision: 0 }
  }
}

async function writeConfig(ctx: any, ops: readonly unknown[]): Promise<void> {
  const form = formOf(ctx)
  if (typeof form?.mutate !== 'function') {
    throw new Error('dsh-provider-proxy: settings transport unavailable')
  }
  await form.mutate(ops as any[], readConfig(ctx).revision)
}

/**
 * The provider rows, read from the Host.
 *
 * This release exposes no client-facing LLM service, so the page cannot ask for
 * the directory itself. The Host serves it at this same-origin endpoint, where
 * `ctx.llm.listProviders()` / `listConfigurableProviders()` actually live. The
 * list is therefore automatic — the user never types a route id.
 *
 * Only ACTIVE routes are shown. A provider this deployment merely *offers* —
 * declared but not registered, so nothing would ever be sent through it — is
 * not the user's business on this page, and listing it only invites them to
 * configure a proxy for a route that cannot be selected. A provider that is
 * already configured is kept regardless, so a saved setting never silently
 * disappears from view.
 */
function knownProviders(configured: Record<string, RouteValue>, published: ProviderRow[]): ProviderRow[] {
  const rows = new Map<string, ProviderRow>()
  const byId = new Map<string, ProviderRow>()
  for (const row of published) {
    byId.set(row.id, row)
    if (row.live) rows.set(row.id, row)
  }
  for (const id of Object.keys(configured)) {
    if (rows.has(id)) continue
    // A saved route must stay visible, but switching the proxy ON does not make
    // its provider live. `live` comes from the Host catalogue exclusively; using
    // `route.enabled` here made a card flip between "offline" and "proxied" as
    // the user toggled the switch, while no provider became available at all.
    const known = byId.get(id)
    rows.set(id, { id, name: known?.name ?? id, live: known?.live === true })
  }
  return [...rows.values()].sort(byName)
}

/**
 * Where the Host publishes the live provider catalogue.
 */
const CATALOG_PATH = '/dsh-provider-proxy/providers'

/** Where the Host runs a per-provider connection self-check. */
const TEST_PATH = '/dsh-provider-proxy/test'

/**
 * Latency bands for the self-check result, in milliseconds.
 *
 * The colour is decoration, never information: the numeric value is always
 * printed, so an unknown theme token (which resolves to `unset`) costs colour,
 * never the reading. The `var(..., fallback)` form keeps the colours visible even
 * if the theme renames the token.
 */
const LATENCY_FAST_MS = 500
const LATENCY_SLOW_MS = 1500
/** The schema default for `testUrl`; also what "Restore default" writes. */
const DEFAULT_TEST_URL = 'https://api.ipify.org?format=json'
const MAX_TEST_URLS = 5

function latencyColor(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return 'var(--dsw-alias-label-secondary)'
  if (ms <= LATENCY_FAST_MS) return 'var(--dsw-alias-state-success-primary, #2ea043)'
  if (ms <= LATENCY_SLOW_MS) return 'var(--dsw-alias-state-warn-primary, #d29922)'
  return 'var(--dsw-alias-state-error-primary, #f85149)'
}

/** Normalize the Host's self-check payload into the shape the card renders. */
function testResultFrom(body: any, strings: Record<string, string>): Record<string, unknown> {
  const ok = body?.ok === true
  return {
    pending: false,
    ok,
    ms: typeof body?.ms === 'number' && Number.isFinite(body.ms) ? body.ms : undefined,
    ip: typeof body?.exitIp === 'string' && body.exitIp.length > 0 ? body.exitIp : undefined,
    // The Host probes a target the way routing would: a loopback/private upstream
    // (or a bypassHosts match) is reached DIRECT, not through the proxy. The card
    // says so, so a green check is not read as "the proxy works".
    direct: body?.viaProxy === false,
    error: ok
      ? undefined
      : typeof body?.error === 'string' && body.error.length > 0
        ? body.error
        : strings.testFailed,
  }
}

/** Split `testUrl` the same way the Host does: commas or whitespace. */
function splitTestUrls(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
}

/**
 * Hint-only validation for `testUrl`.
 *
 * The Host does not refuse malformed candidates; it simply fails that check.
 * The page therefore warns without blocking the write, so a user can still save
 * a value the Host accepts (including an empty string, which means "use the
 * built-in default").
 */
function testUrlHint(raw: string, t: Record<string, string>): string | undefined {
  const entries = splitTestUrls(raw)
  if (entries.length === 0) return t.testUrlEmptyHint
  const invalid = entries.filter(entry => !isAbsoluteHttpUrl(entry))
  if (invalid.length > 0) return t.testUrlInvalidHint
  if (entries.length > MAX_TEST_URLS) return t.testUrlTooManyHint
  return undefined
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * Remove values and URL credentials from text that will be shown to the user.
 *
 * Settings errors may quote the rejected value. A password field must never
 * echo that value, even inside an otherwise useful error message, so exact
 * known secrets are replaced before anything is rendered or written to the
 * diagnostics panel.
 */
function redactSensitiveText(text: string, secrets: readonly unknown[] = []): string {
  let safe = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue
    safe = safe.split(secret).join('***')
  }
  // A URL in an error may carry userinfo and query/fragment values even when
  // the individual secret is not known to this call.
  safe = safe.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1')
  safe = safe.replace(/([?&#])[^\s"'<>]*/g, '$1')
  return safe.length > 500 ? `${safe.slice(0, 500)}…` : safe
}

/** Values that may be echoed by a failed multi-field write. */
function secretsFromOps(ops: readonly any[]): string[] {
  const out: string[] = []
  for (const op of ops) {
    const field = op?.path?.[op.path.length - 1]
    if (field === 'password' && typeof op?.value === 'string' && op.value.length > 0) {
      out.push(op.value)
    }
  }
  return out
}

/**
 * The setter the lazy catalogue initializer resolves through.
 *
 * It is republished after every render, so the newest one always wins, and a
 * promise that settles after an unmount writes to a harmless no-op.
 */
let catalogueSetter: ((catalog: Catalog) => void) | undefined = () => {}

/** How one provider's last proxied request ended, as the Host recorded it. */
type LastUse = {
  /** When the most recent proxied request BEGAN. */
  startedAt?: number
  /** When the last request that FINISHED ended; paired with `ok`/`code`. */
  at?: number
  ok?: boolean
  code?: string
}

/** What the Host endpoint publishes: provider rows, hit counts, rejected routes. */
type Catalog = {
  rows: ProviderRow[]
  hits: Record<string, number>
  problems: Record<string, string>
  lastUse: Record<string, LastUse>
  /** Set when the FIRST read failed; a later successful poll clears it. */
  error?: string
}

/**
 * A coarse "how long ago", for the last-use line.
 *
 * Deliberately coarse: the page only re-reads the catalogue every 10 s, so a
 * second-precision string would look stale on its own and mean nothing.
 */
function relativeTime(at: number, t: Record<string, string>): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 60) return t.justNow
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}${t.minutesAgo}`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}${t.hoursAgo}`
  return `${Math.floor(hours / 24)}${t.daysAgo}`
}

/** Read the Host's provider catalogue. Same-origin, so no token is needed. */
async function fetchCatalog(): Promise<Catalog> {
  const response = await globalThis.fetch(CATALOG_PATH, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Host answered ${response.status}`)
  const body = await response.json()
  const list = Array.isArray(body?.providers) ? body.providers : []
  const rows = list
    .filter((row: any) => typeof row?.id === 'string' && row.id.length > 0)
    .map((row: any) => ({
      id: row.id,
      name: typeof row.name === 'string' && row.name.length > 0 ? row.name : row.id,
      live: row.live === true,
    }))
  // The Host counts requests it routed through each provider's proxy. Anything
  // malformed is dropped rather than rendered, so a bad payload cannot put a
  // non-numeric string on the page.
  const hits: Record<string, number> = {}
  const published = body?.hits
  if (published !== null && typeof published === 'object') {
    for (const [id, count] of Object.entries(published)) {
      if (typeof count === 'number' && Number.isFinite(count)) hits[id] = count
    }
  }
  // A route the Host REFUSED (a bad port, half-filled credentials) is absent from
  // the provider list entirely, so this map is the only place that says why it is
  // missing. The Host already stripped the log prefix from it.
  const problems: Record<string, string> = {}
  const rejected = body?.problems
  if (rejected !== null && typeof rejected === 'object') {
    for (const [id, message] of Object.entries(rejected)) {
      if (typeof message === 'string' && message.length > 0) problems[id] = message
    }
  }
  // The last-use record: when each provider's most recent proxied request
  // began, and — separately — how the last request that FINISHED ended. Anything
  // malformed is dropped rather than rendered, so a bad payload cannot put a
  // non-numeric timestamp on the page. An entry carrying only `startedAt` is
  // kept: it is a request still in flight, and the page says when it was started.
  const lastUse: Record<string, LastUse> = {}
  const publishedLastUse = body?.lastUse
  if (publishedLastUse !== null && typeof publishedLastUse === 'object') {
    for (const [id, raw] of Object.entries(publishedLastUse)) {
      const entry = raw as LastUse | undefined
      if (entry === null || typeof entry !== 'object') continue
      const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : undefined
      const startedAt =
        typeof entry.startedAt === 'number' && Number.isFinite(entry.startedAt)
          ? entry.startedAt
          : undefined
      if (at === undefined && startedAt === undefined) continue
      lastUse[id] = {
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(at === undefined ? {} : { at }),
        ...(typeof entry.ok === 'boolean' ? { ok: entry.ok } : {}),
        ...(typeof entry.code === 'string' && entry.code.length > 0 ? { code: entry.code } : {}),
      }
    }
  }
  return { rows, hits, problems, lastUse }
}

/**
 * Catalogue polling while the page is open.
 *
 * The catalogue (published rows, hit counts, rejected routes) is fetched once at
 * mount and would otherwise stay a snapshot for the page's lifetime: the hit
 * counter never moves, and a route the Host starts or stops refusing stays
 * invisible. One shared interval re-fetches it every CATALOG_REFRESH_MS.
 *
 * `touchCatalogPolling` runs on every render. Writing the module-level timestamp
 * there is deliberately not treated as a render side effect: it is idempotent,
 * re-enters nothing (unlike a setState during render), and it is the only signal
 * that the page is still alive. A page that stops rendering — a closed panel —
 * goes stale, and the next tick cancels the interval instead of fetching for
 * nobody. A failed poll is swallowed: the page keeps its last data, and the
 * mount-time fetch already reports a broken endpoint in the diagnostics.
 */
const CATALOG_REFRESH_MS = 10_000
let catalogPoll: ReturnType<typeof setInterval> | undefined
let catalogTouchedAt = 0

function touchCatalogPolling(): void {
  catalogTouchedAt = Date.now()
  if (catalogPoll !== undefined) return
  catalogPoll = setInterval(() => {
    if (Date.now() - catalogTouchedAt > CATALOG_REFRESH_MS * 2 + 1_000) {
      clearInterval(catalogPoll)
      catalogPoll = undefined
      return
    }
    void fetchCatalog()
      .then(catalog => catalogueSetter?.(catalog))
      .catch(() => undefined)
  }, CATALOG_REFRESH_MS)
}

const byName = (a: ProviderRow, b: ProviderRow): number => a.name.localeCompare(b.name)

/**
 * Rule entries that can never match anything.
 *
 * The Host's matcher compares a lower-cased target HOSTNAME against entries
 * (suffix match, `*` for all) — so an entry carrying a scheme (`https://…`) or
 * a path (`example.com/v1`) never matches, and the rule silently does the
 * opposite of what the user typed: a malformed `onlyHosts` entry makes
 * fail-closed send traffic DIRECT while the user believes it is proxied. The
 * Host cannot warn about this — refusing the whole route over a rule typo
 * would break proxying that still works — so the page flags the value exactly
 * where it is typed, from the merged view (draft included).
 */
function deadRuleEntries(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map(entry => entry.trim())
    .filter(entry => /^[a-z][a-z0-9+.-]*:\/\//i.test(entry) || entry.includes('/'))
}

function view(route: Partial<RouteValue> | undefined): RouteValue {
  return {
    enabled: route?.enabled === true,
    useDefault: route?.useDefault === true,
    protocol: PROTOCOLS.includes(route?.protocol as Protocol) ? (route!.protocol as Protocol) : 'http',
    host: route?.host ?? '',
    port: route?.port ?? 0,
    username: route?.username ?? '',
    password: route?.password ?? '',
    onlyHosts: route?.onlyHosts ?? '',
    bypassHosts: route?.bypassHosts ?? '',
    testTarget: route?.testTarget ?? '',
  }
}

/** Drop the brackets WHATWG URL keeps on an IPv6 literal host. */
function unbracket(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/**
 * Split a pasted full proxy URL into route fields, or `undefined` when the text
 * is not one.
 *
 * `socks5` is a NON-special scheme, so WHATWG URL still parses its userinfo and
 * port (verified), but three quirks are handled here:
 *  - the userinfo is NOT percent-decoded by the parser, so it is decoded here;
 *  - an IPv6 literal comes back bracketed, and the host field wants it bare;
 *  - a DEFAULT port is stripped by WHATWG for http/https; the original text is
 *    consulted so an explicitly written :80/:443 is preserved, while an absent
 *    port still stays 0 ("not configured") instead of being invented.
 */
function explicitPortOf(text: string): number {
  const authority = text.slice(text.indexOf('://') + 3).split(/[/?#]/, 1)[0]
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  const match = /^\[[^\]]+\]:(\d+)$/.exec(hostPort) ?? /^[^:]+:(\d+)$/.exec(hostPort)
  if (match === null) return 0
  const port = Number.parseInt(match[1], 10)
  return Number.isNaN(port) ? 0 : port
}

function splitProxyUrl(text: string): Partial<RouteValue> | undefined {
  const trimmed = text.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase()
  // `socks://` is a common spelling this plugin does not accept on its own;
  // normalizing it here means a pasted alias still lands on the supported
  // transport instead of being rejected later.
  const protocol = scheme === 'socks' ? 'socks5' : scheme
  if (!PROTOCOLS.includes(protocol as Protocol)) return undefined
  if (url.hostname.length === 0) return undefined
  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  const parsedPort = url.port.length > 0
    ? Number.parseInt(url.port, 10)
    : explicitPortOf(trimmed)
  return {
    protocol: protocol as Protocol,
    host: unbracket(url.hostname),
    port: Number.isNaN(parsedPort) ? 0 : parsedPort,
    username: decode(url.username),
    password: decode(url.password),
  }
}

/**
 * Pending writes, one debounced timer per provider+field.
 *
 * Every keystroke of an input fires `bind`, and the Host rebuilds its whole
 * proxy table on each settings write (`loader/volatile-update` → `rebuild()`).
 * Writing per keystroke therefore churns a dispatcher generation per character —
 * and, worse, a half-typed credential ("username without a password") hits the
 * Host guards between keystrokes, so the route is refused for an instant and a
 * misleading problem is recorded. Only the LAST value of a burst needs to reach
 * the Host; the draft already gives the control its instant feedback.
 *
 * Module-level, so the timers survive a re-render (each pass rebuilds `save`)
 * and a page unmount: a write that was already promised still lands.
 */
const WRITE_DELAY_MS = 300
type PendingWrite = { timer?: ReturnType<typeof setTimeout>; flush: () => Promise<void> }
const pendingWrites = new Map<string, PendingWrite>()

/**
 * Writes are serialized so a test can await every write it flushed without
 * racing the settings revision fence. A run handles its own failures, so the
 * tail never rejects the next write.
 */
let writeQueue: Promise<void> = Promise.resolve()
function enqueueWrite(run: () => Promise<void>): Promise<void> {
  const next = writeQueue.then(run, run)
  writeQueue = next.catch(() => undefined)
  return next
}

/** Schedule one debounced write; `flush` runs it immediately and only once. */
function scheduleWrite(key: string, run: () => Promise<void>): void {
  const pending = pendingWrites.get(key)
  if (pending?.timer !== undefined) clearTimeout(pending.timer)
  const entry: PendingWrite = {
    flush: () => {
      if (entry.timer !== undefined) clearTimeout(entry.timer)
      pendingWrites.delete(key)
      return enqueueWrite(run)
    },
  }
  entry.timer = setTimeout(() => { void entry.flush() }, WRITE_DELAY_MS)
  pendingWrites.set(key, entry)
}

/**
 * A self-check result belongs to the configuration it was measured against.
 * Every relevant edit bumps this counter; a response that started under an older
 * generation is discarded instead of being pasted onto the new settings.
 */
const testGeneration = new Map<string, number>()
const TEST_RELEVANT_FIELDS = new Set([
  'protocol',
  'host',
  'port',
  'username',
  'password',
  'onlyHosts',
  'bypassHosts',
  'testTarget',
  'useDefault',
])

/** The provider directory, cached module-side. See renderPage. */
let directoryCache: ProviderRow[] | undefined

/**
 * Everything the page learned about its own wiring, rendered verbatim.
 *
 * The browser side of a plugin has no other diagnostic channel — the Host log
 * never sees it — so a silent failure had to be diagnosed by inference. This
 * panel is what proved that `remote.settings` and `remote.llm` do not exist in
 * this release, and that the catalogue had to come from the Host endpoint.
 *
 * Cleared at the start of every render so the panel shows the CURRENT state
 * rather than an ever-growing log of the session.
 */
let diagnostics: string[] = []

function note(message: string): void {
  if (!diagnostics.includes(message)) diagnostics.push(message)
}

/**
 * Layout constants, applied as INLINE styles.
 *
 * The page is rendered into the settings panel, and the CSS-Modules pipeline
 * that feeds the stylesheet has broken twice in ways that were invisible from
 * the source: the class map failed to bind at all, and a shared class prefix
 * silently merged two rules. Both left the page readable but laid out as one
 * unstyled block.
 *
 * Structure is therefore expressed as inline styles, which cannot be lost by
 * the bundle, and the stylesheet is kept for the purely decorative parts. A
 * theme token that is not defined simply resolves to `unset`, so an unknown
 * token costs colour, never layout.
 */
const S = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    maxWidth: '720px',
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    padding: '14px 16px',
    marginBottom: '12px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  cardActive: {
    borderColor: 'var(--dsw-alias-state-success-primary)',
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  /** An enabled route the Host refused: active-looking styling would be a lie. */
  cardRejected: {
    borderColor: 'var(--dsw-alias-state-error-primary, #f85149)',
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  },
  titles: { display: 'flex', alignItems: 'baseline', gap: '8px', minWidth: '0' },
  name: {
    fontSize: '14px',
    fontWeight: '600',
    color: 'var(--dsw-alias-label-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  id: {
    flex: 'none',
    padding: '1px 6px',
    borderRadius: '4px',
    background: 'var(--dsw-alias-bg-layer-2)',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '11px',
    color: 'var(--dsw-alias-label-secondary)',
  },
  hits: {
    flex: 'none',
    fontSize: '11px',
    color: 'var(--dsw-alias-label-secondary)',
    whiteSpace: 'nowrap',
  },
  testRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexWrap: 'wrap',
  },
  testButton: {
    padding: '5px 12px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: '12px',
    cursor: 'pointer',
  },
  testResult: {
    fontSize: '11px',
    color: 'var(--dsw-alias-label-secondary)',
    wordBreak: 'break-all',
  },
  /**
   * A failed check is the answer, not decoration: it takes the error colour and
   * a heavier weight, unlike the latency band colour which only tints a number
   * that is printed anyway.
   */
  testFailure: {
    color: 'var(--dsw-alias-state-error-primary, #f85149)',
    fontWeight: '500',
  },
  /** A rejected route is a failure of the settings, not a warning about them. */
  diagProblem: {
    color: 'var(--dsw-alias-state-error-primary, #f85149)',
  },
  advanced: {
    marginTop: '4px',
    fontSize: '12px',
  },
  advancedSummary: {
    cursor: 'pointer',
    fontSize: '11px',
    color: 'var(--dsw-alias-label-secondary)',
  },
  pill: {
    flex: 'none',
    padding: '2px 10px',
    borderRadius: '999px',
    fontSize: '11px',
    fontWeight: '500',
    whiteSpace: 'nowrap',
  },
  pillOn: {
    background: 'var(--dsw-alias-state-success-primary)',
    color: 'var(--dsw-alias-bg-base)',
  },
  pillLive: {
    border: '1px solid var(--dsw-alias-border-l2)',
    color: 'var(--dsw-alias-label-secondary)',
  },
  pillOff: { color: 'var(--dsw-alias-state-idle-primary)' },
  pillRejected: {
    border: '1px solid var(--dsw-alias-state-error-primary, #f85149)',
    color: 'var(--dsw-alias-state-error-primary, #f85149)',
  },
  /**
   * The shared default endpoint sits on its own layer so it reads as global
   * rather than as one more provider card — the mistake it exists to prevent is
   * a user typing the same address into every card.
   */
  defaultCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '14px 16px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  defaultLead: {
    margin: '-2px 0 0',
    fontSize: '11px',
    lineHeight: '1.5',
    color: 'var(--dsw-alias-label-secondary)',
  },
  inheritNote: {
    margin: '0',
    fontSize: '11px',
    lineHeight: '1.5',
    color: 'var(--dsw-alias-label-secondary)',
  },
  /** The default is not configured: an answer, so it takes the error colour. */
  inheritWarning: {
    margin: '0',
    fontSize: '11px',
    lineHeight: '1.5',
    fontWeight: '500',
    color: 'var(--dsw-alias-state-error-primary, #f85149)',
  },
  toggle: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-primary)',
  },
  field: {
    display: 'grid',
    gridTemplateColumns: '88px 1fr',
    alignItems: 'center',
    gap: '10px',
    fontSize: '12px',
  },
  label: { color: 'var(--dsw-alias-label-secondary)' },
  input: {
    boxSizing: 'border-box',
    width: '100%',
    minWidth: '0',
    padding: '6px 8px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '6px',
    outline: 'none',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    font: 'inherit',
    fontSize: '12px',
  },
  diag: {
    marginTop: '4px',
    padding: '8px 10px',
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: '8px',
    fontSize: '11px',
    color: 'var(--dsw-alias-label-secondary)',
  },
  hint: {
    gridColumn: '2',
    fontSize: '11px',
    color: 'var(--dsw-alias-label-secondary)',
  },
} as const

function renderPage(ctx: any): unknown {
  const React = react()
  if (React === undefined || typeof React.createElement !== 'function') return null

  const h = React.createElement
  const t = stringsFor(ctx)
  diagnostics = []

  // `useState` is only reached after the React check, so the early return above
  // cannot desync the hooks order.
  let snapshot: { value: any; revision: number }
  try {
    snapshot = readConfig(ctx)
  } catch {
    snapshot = { value: {}, revision: 0 }
  }
  const configured = (snapshot.value?.providers ?? {}) as Record<string, RouteValue>
  note(
    formOf(ctx) === undefined
      ? '设置：未找到 configForms 服务，只能显示、无法保存'
      : `设置：正常（修订号 ${snapshot.revision}，${Object.keys(configured).length} 个 provider）`,
  )

  // The provider catalogue comes from the Host over a same-origin endpoint, so
  // it arrives asynchronously. The initial state is a LAZY initializer, so the
  // fetch starts from `useState(() => …)` instead of by calling a setter during
  // render: a render must have no side effects, and doing so also shifted the
  // hook order between passes.
  const [state, setState] = (React.useState ?? ((fn: any) => [fn(), () => {}]))(() => {
    void fetchCatalog()
      .then(catalog => catalogueSetter?.(catalog))
      .catch((error: any) => {
        catalogueSetter?.({
          rows: [],
          hits: {},
          problems: {},
          lastUse: {},
          error: String(error?.message ?? error),
        })
      })
    return {
      rows: undefined as ProviderRow[] | undefined,
      hits: {} as Record<string, number>,
      problems: {} as Record<string, string>,
      lastUse: {} as Record<string, LastUse>,
      error: undefined as string | undefined,
      pending: true,
    }
  })
  // The setter is published right after the hook so the initializer's promise
  // can reach it. It is re-published on every render, so the latest wins.
  catalogueSetter = catalog =>
    setState({
      rows: catalog.rows,
      hits: catalog.hits,
      problems: catalog.problems,
      lastUse: catalog.lastUse,
      error: catalog.error,
      pending: false,
    })
  // Keeps the catalogue (rows, hit counts, rejected routes) current while the
  // page is open; see the function's own notes for the staleness handling.
  touchCatalogPolling()

  const published = state.rows ?? []
  const hits = state.hits ?? {}
  const lastUse = state.lastUse ?? {}

  /**
   * The one-line last-use summary for a card, or `undefined` when the route has
   * never carried a request. `hits` says the route HAS been used; this says
   * whether it still works — the question a silently stalled proxy raises.
   *
   * A success or failure uses `at`, the time the last request FINISHED — the
   * time its outcome belongs to. A request that has only STARTED uses
   * `startedAt`, so a still-in-flight call cannot make the page claim an outcome
   * it does not have yet.
   */
  const lastUseText = (id: string): string | undefined => {
    const use = lastUse[id]
    if (use === undefined) return undefined
    if (use.ok === true) return `${t.recentOk}${relativeTime(use.at ?? use.startedAt ?? Date.now(), t)}`
    if (use.ok === false) return `${t.recentFail}${use.code ?? 'ERROR'}`
    return `${t.recentStarted}${relativeTime(use.startedAt ?? use.at ?? Date.now(), t)}`
  }
  // Rendered straight from state rather than through `note()`: `diagnostics` is
  // cleared at the start of every render, so a note written when the catalog
  // arrives would not survive to the next pass.
  const problems = state.problems ?? {}
  const problemLines = Object.entries(problems).map(([id, message]) =>
    h('li', { key: `p:${id}`, style: S.diagProblem }, `${id}：${message}`),
  )
  const problemCount = problemLines.length
  note(
    `provider 列表：来自 Host 共 ${published.length} 个（${published.map((r: ProviderRow) => r.id).join('、') || '无'}）`,
  )
  // Local draft, layered over the stored config.
  //
  // Without it a checkbox does not change until the panel remounts: the value
  // is read from the settings store, which only updates when the page is
  // rebuilt. The draft makes the control respond immediately, then reconciles
  // with the store so a refused write is visible rather than silently lost.
  const [draft, setDraft] = (React.useState ?? ((v: any) => [v, () => {}]))({})
  const edit = (id: string, field: string, value: unknown) =>
    setDraft((current: any) => ({ ...current, [id]: { ...current[id], [field]: value } }))

  /**
   * The shared default endpoint gets its own draft for the same reason a card
   * does: its controls must show an edit before the debounced write lands.
   *
   * It is deliberately NOT stored under a sentinel key inside `draft`:
   * `knownProviders` unions the stored config with the draft to build the card
   * list, so such a key would surface as a phantom provider with no name.
   */
  const [defaultDraft, setDefaultDraft] = (React.useState ?? ((v: any) => [v, () => {}]))({})
  const editDefault = (field: string, value: unknown) =>
    setDefaultDraft((current: any) => ({ ...current, [field]: value }))

  /**
   * The advanced global fields live outside `draft` on purpose: `draft` is keyed
   * by provider id, and a sentinel would surface as a phantom provider row.
   */
  const [globalDraft, setGlobalDraft] = (React.useState ?? ((v: any) => [v, () => {}]))({})
  const editGlobal = (field: string, value: unknown) =>
    setGlobalDraft((current: any) => ({ ...current, [field]: value }))

  /** The latest refused write, shown above the cards instead of in the fold. */
  const [saveError, setSaveError] = (React.useState ?? ((v: any) => [v, () => {}]))(undefined)
  /** The latest accepted write, rendered in the diagnostics on the next pass. */
  const [savedNote, setSavedNote] = (React.useState ?? ((v: any) => [v, () => {}]))(undefined)

  // Self-check outcomes keyed by provider id: `{ pending: true }` while the Host
  // is testing, then the normalized result the card renders.
  const [tests, setTests] = (React.useState ?? ((v: any) => [v, () => {}]))({})

  /** Drop results for these providers and invalidate any response in flight. */
  const invalidateTests = (ids: readonly string[]): void => {
    if (ids.length === 0) return
    for (const id of ids) {
      testGeneration.set(id, (testGeneration.get(id) ?? 0) + 1)
    }
    setTests((current: any) => {
      let changed = false
      const next = { ...current }
      for (const id of ids) {
        if (next[id] === undefined) continue
        delete next[id]
        changed = true
      }
      return changed ? next : current
    })
  }

  /**
   * The list filter. Purely a view concern: it hides cards, it never touches a
   * saved setting, so a page with no filter one day still shows every route.
   */
  const [filter, setFilter] = (React.useState ?? ((v: any) => [v, () => {}]))('')

  /**
   * Run the Host's self-check for one provider.
   *
   * The check is not routed traffic, so it never changes the hit count; the count
   * on the card is read at mount and stays put until the page reloads.
   *
   * Pending writes for this provider (and the shared default it may inherit) are
   * flushed before the request: the Host reads the saved settings, not the draft,
   * so testing inside the 300 ms debounce would otherwise test the old endpoint.
   */
  const runTest = (id: string): void => {
    const generation = (testGeneration.get(id) ?? 0) + 1
    testGeneration.set(id, generation)
    setTests((current: any) => ({ ...current, [id]: { pending: true } }))
    void (async () => {
      try {
        for (const [key, entry] of [...pendingWrites]) {
          if (
            key.startsWith(`${id}\u0000`) ||
            key.startsWith('\u0000default\u0000') ||
            key.startsWith('\u0000global\u0000')
          ) {
            void entry.flush()
          }
        }
        await writeQueue
        if (testGeneration.get(id) !== generation) return
        const response = await globalThis.fetch(TEST_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ provider: id }),
        })
        const body = await response.json()
        if (testGeneration.get(id) !== generation) return
        setTests((current: any) => ({ ...current, [id]: testResultFrom(body, t) }))
      } catch (error: any) {
        if (testGeneration.get(id) !== generation) return
        setTests((current: any) => ({
          ...current,
          [id]: { pending: false, ok: false, error: String(error?.message ?? error) },
        }))
      }
    })()
  }

  const rows = knownProviders({ ...configured, ...draft }, published)

  /** Cards whose effective endpoint comes from the shared default. */
  const inheritingIds = (): string[] =>
    rows
      .filter(row => view({ ...configured[row.id], ...draft[row.id] }).useDefault === true)
      .map(row => row.id)

  /**
   * Persist one field, debounced per `key`: a burst of edits to the same control
   * collapses into ONE write carrying the last value. The control already shows
   * the new value via the draft, so this only has to succeed quietly; a refusal
   * is reported in the diagnostics and undone by `onRefused`.
   */
  const save = (
    key: string,
    path: unknown[],
    label: string,
    value: unknown,
    onRefused: () => void,
  ) => {
    const field = path[path.length - 1]
    const secret = field === 'password' && typeof value === 'string' ? value : undefined
    const safeLabel = secret === undefined ? label : `${label}（值已隐藏）`
    scheduleWrite(key, () =>
      writeConfig(ctx, [{ op: 'set', path, value }])
        .then(() => {
          setSaveError(undefined)
          setSavedNote(secret === undefined ? `已保存 ${label}` : `已保存 ${safeLabel}`)
        })
        .catch((error: any) => {
          const message = redactSensitiveText(String(error?.message ?? error), [
            ...(secret === undefined ? [] : [secret]),
          ])
          setSavedNote(undefined)
          setSaveError({ label: safeLabel, message })
          onRefused()
        }),
    )
  }

  /**
   * Undo ONE refused field in a card's draft.
   *
   * Only that field is dropped. Other fields of the same provider may hold edits
   * that are still pending or already accepted — dropping the whole draft entry
   * would throw away values the Host never objected to. An entry left empty by
   * the removal is dropped entirely, so it cannot keep a phantom row alive.
   */
  const rollbackRouteField = (id: string, field: string): void => {
    setDraft((current: any) => {
      const entry = current[id]
      if (entry === undefined || entry[field] === undefined) return current
      const nextEntry = { ...entry }
      delete nextEntry[field]
      const next = { ...current }
      if (Object.keys(nextEntry).length === 0) delete next[id]
      else next[id] = nextEntry
      return next
    })
  }

  /** One card control: update the draft instantly, persist in the background. */
  const bind = (id: string, field: string) => (value: unknown) => {
    edit(id, field, value)
    if (TEST_RELEVANT_FIELDS.has(field)) invalidateTests([id])
    save(`${id}\u0000${field}`, ['providers', id, field], `${id}.${field}`, value, () =>
      rollbackRouteField(id, field),
    )
  }

  /** One default-block control: same contract, addressed at `defaultProxy`. */
  const bindDefault = (field: string) => (value: unknown) => {
    editDefault(field, value)
    invalidateTests(inheritingIds())
    save(`\u0000default\u0000${field}`, ['defaultProxy', field], `defaultProxy.${field}`, value, () => {
      // Same rule as a card field: drop only this field, and only if the draft
      // still holds it, so an already-accepted sibling edit is never discarded.
      setDefaultDraft((current: any) => {
        if (current[field] === undefined) return current
        const next = { ...current }
        delete next[field]
        return next
      })
    })
  }

  /** One advanced global control: draft, invalidate every check, persist. */
  const bindGlobal = (field: 'testUrl' | 'localDirect') => (value: unknown) => {
    editGlobal(field, value)
    invalidateTests(rows.map(row => row.id))
    save(`\u0000global\u0000${field}`, [field], field, value, () => {
      setGlobalDraft((current: any) => {
        if (current[field] === undefined) return current
        const next = { ...current }
        delete next[field]
        return next
      })
    })
  }

  /**
   * One debounced write carrying SEVERAL edits at once.
   *
   * Used for a pasted proxy URL: five separate writes would each rebuild the
   * Host's whole proxy table, and a half-applied paste (credentials without the
   * host, say) would hit the credential guards mid-burst — the same trap the
   * per-field debounce exists to avoid.
   */
  const saveMany = (key: string, ops: unknown[], label: string, onRefused: () => void) => {
    const secrets = secretsFromOps(ops as any[])
    const hidesValues = (ops as any[]).some(op => op?.path?.[op.path.length - 1] === 'password')
    const safeLabel = hidesValues ? `${label}（值已隐藏）` : label
    scheduleWrite(key, () =>
      writeConfig(ctx, ops)
        .then(() => {
          setSaveError(undefined)
          setSavedNote(`已保存 ${safeLabel}`)
        })
        .catch((error: any) => {
          const message = redactSensitiveText(String(error?.message ?? error), secrets)
          setSavedNote(undefined)
          setSaveError({ label: safeLabel, message })
          onRefused()
        }),
    )
  }

  /** Undo one set of pasted fields in a card's draft. */
  const rollbackRouteFields = (id: string, fields: readonly string[]): void => {
    setDraft((current: any) => {
      const entry = current[id]
      if (entry === undefined) return current
      const nextEntry = { ...entry }
      for (const field of fields) delete nextEntry[field]
      const next = { ...current }
      if (Object.keys(nextEntry).length === 0) delete next[id]
      else next[id] = nextEntry
      return next
    })
  }

  /** Apply a parsed proxy URL to one card: one draft update, one write. */
  const applyCardUrl = (id: string, parts: Record<string, unknown>): void => {
    setDraft((current: any) => ({ ...current, [id]: { ...current[id], ...parts } }))
    invalidateTests([id])
    const fields = Object.keys(parts)
    saveMany(
      `${id}\u0000*paste`,
      fields.map(field => ({ op: 'set', path: ['providers', id, field], value: parts[field] })),
      `${id}.*（粘贴代理 URL）`,
      () => rollbackRouteFields(id, fields),
    )
  }

  /** Apply a parsed proxy URL to the shared default endpoint. */
  const applyDefaultUrl = (parts: Record<string, unknown>): void => {
    setDefaultDraft((current: any) => ({ ...current, ...parts }))
    invalidateTests(inheritingIds())
    const fields = Object.keys(parts)
    saveMany(
      '\u0000default\u0000*paste',
      fields.map(field => ({ op: 'set', path: ['defaultProxy', field], value: parts[field] })),
      '默认代理（粘贴代理 URL）',
      () => {
        setDefaultDraft((current: any) => {
          const next = { ...current }
          for (const field of fields) delete next[field]
          return next
        })
      },
    )
  }

  /**
   * Promote a card's own endpoint to the shared default.
   *
   * The reduced form of "copy this card to another": once the endpoint lives in
   * the default block, every other card opts in with one switch, so a
   * multi-select picker would be a second way to do the same thing.
   */
  const promoteToDefault = (id: string): void => {
    const route = view({ ...configured[id], ...draft[id] })
    applyDefaultUrl({
      protocol: route.protocol,
      host: route.host.trim(),
      port: route.port,
      username: route.username,
      password: route.password,
    })
  }

  /** Point every card at the default endpoint, in one write. */
  const applyDefaultToAll = (): void => {
    const ids = rows.map(row => row.id)
    if (ids.length === 0) return
    setDraft((current: any) => {
      const next = { ...current }
      for (const id of ids) next[id] = { ...next[id], useDefault: true }
      return next
    })
    invalidateTests(ids)
    saveMany(
      '\u0000default\u0000applyAll',
      ids.map(id => ({ op: 'set', path: ['providers', id, 'useDefault'], value: true })),
      '所有 provider 的 useDefault',
      () =>
        setDraft((current: any) => {
          const next = { ...current }
          for (const id of ids) {
            const entry = next[id]
            if (entry === undefined || entry.useDefault === undefined) continue
            const nextEntry = { ...entry }
            delete nextEntry.useDefault
            if (Object.keys(nextEntry).length === 0) delete next[id]
            else next[id] = nextEntry
          }
          return next
        }),
    )
  }

  /**
   * A paste handler for any proxy-address field.
   *
   * Only a RECOGNISED proxy URL is intercepted; anything else falls through to
   * the browser so a pasted bare host still lands in the field normally.
   */
  const onProxyUrlPaste =
    (apply: (parts: Record<string, unknown>) => void) =>
    (event: any): void => {
      const text = event?.clipboardData?.getData?.('text')
      if (typeof text !== 'string') return
      const parts = splitProxyUrl(text)
      if (parts === undefined) return
      event.preventDefault?.()
      apply(parts)
    }

  const field = (label: string, control: unknown, hint?: string, hintError?: boolean): unknown =>
    h(
      'label',
      { className: styles.field, style: S.field, key: label },
      h('span', { className: styles.label, style: S.label }, label),
      control,
      hint === undefined
        ? null
        : h(
            'span',
            {
              className: styles.hint,
              style: {
                gridColumn: '2',
                fontSize: '11px',
                // A warning that a value can never work is an answer, not
                // decoration — same rule as the failed self-check text.
                ...(hintError === true
                  ? { color: 'var(--dsw-alias-state-error-primary, #f85149)' }
                  : {}),
              },
            },
            hint,
          ),
    )

  /**
   * The shared endpoint block, always rendered.
   *
   * It is the only place the address can be entered, so hiding it until some
   * card opts in would leave no way to configure it in the first place.
   */
  const storedDefault = (snapshot.value?.defaultProxy ?? {}) as Partial<RouteValue>
  const defaultView = view({ ...storedDefault, ...defaultDraft })
  // The SAME predicate the Host applies, imported rather than re-written: a
  // browser copy that only checked "host non-empty and port in range" called
  // `https://1.2.3.4` complete and enabled the bulk button, while the Host refused
  // every route pointed at it.
  //
  // The REASON is kept as well as the verdict: the block refuses for several
  // reasons (no host, a scheme-carrying host, a bad port, a half-filled
  // credential), and a card that said "missing host or port" for all of them sent
  // the user to the one field that was already correct.
  const defaultWhy = defaultProxyProblem(defaultView)
  // An empty optional block is "not configured", not a typed mistake. Only an
  // invalid NON-empty host gets the error colour under the input.
  const defaultHostWhy = defaultView.host.trim().length === 0
    ? undefined
    : proxyHostProblem(defaultView.host)
  const defaultComplete = defaultWhy === undefined
  const defaultOrigin = `${defaultView.protocol}://${defaultView.host}:${defaultView.port}`
  const defaultBlock = h(
    'div',
    { className: styles.defaultCard, style: S.defaultCard, key: 'default-proxy' },
    h(
      'header',
      { className: styles.cardHead, style: S.head },
      h(
        'div',
        { className: styles.cardTitles, style: S.titles },
        h('span', { className: styles.name, style: S.name }, t.defaultTitle),
      ),
      h(
        'span',
        {
          className: defaultComplete ? styles.pillOn : styles.pillOff,
          style: { ...S.pill, ...(defaultComplete ? S.pillOn : S.pillOff) },
        },
        defaultComplete ? t.complete : t.notConfigured,
      ),
    ),
    h('p', { className: styles.defaultLead, style: S.defaultLead }, t.defaultLead),
    field(
      t.protocol,
      h(
        'select',
        {
          className: styles.input,
          style: S.input,
          value: defaultView.protocol,
          onChange: (event: any) => bindDefault('protocol')(event.target.value),
        },
        ...PROTOCOLS.map(protocol =>
          h('option', { key: protocol, value: protocol }, protocol.toUpperCase()),
        ),
      ),
    ),
    field(
      t.host,
      h('input', {
        className: styles.input,
        style: S.input,
        placeholder: '127.0.0.1',
        value: defaultView.host,
        onChange: (event: any) => bindDefault('host')(event.target.value),
        // Same convenience as the cards: a full URL fills the whole block.
        onPaste: onProxyUrlPaste(applyDefaultUrl),
      }),
      defaultHostWhy ?? t.hostHint,
      defaultHostWhy !== undefined,
    ),
    field(
      t.port,
      h('input', {
        className: styles.input,
        style: S.input,
        type: 'number',
        min: 1,
        max: 65535,
        placeholder: '7890',
        value: defaultView.port === 0 ? '' : String(defaultView.port),
        onChange: (event: any) => {
          const parsed = Number.parseInt(event.target.value, 10)
          bindDefault('port')(Number.isNaN(parsed) ? 0 : parsed)
        },
      }),
    ),
    field(
      t.username,
      h('input', {
        className: styles.input,
        style: S.input,
        autocomplete: 'off',
        value: defaultView.username,
        onChange: (event: any) => bindDefault('username')(event.target.value),
      }),
    ),
    field(
      t.password,
      h('input', {
        className: styles.input,
        style: S.input,
        type: 'password',
        autocomplete: 'off',
        value: defaultView.password,
        onChange: (event: any) => bindDefault('password')(event.target.value),
      }),
      t.passwordHintProxy,
    ),
    // Bulk opt-in, in ONE write: a per-card walk would rebuild the table N times.
    // Disabled while the default configuration is incomplete, because pointing every card at an
    // empty endpoint would just refuse them all.
    h(
      'div',
      { style: S.testRow, key: 'default:apply' },
      h(
        'button',
        {
          className: styles.testButton,
          style: S.testButton,
          type: 'button',
          disabled: !defaultComplete || rows.length === 0,
          onClick: applyDefaultToAll,
        },
        t.applyDefaultAll,
      ),
    ),
  )

  const storedTestUrl =
    typeof snapshot.value?.testUrl === 'string' ? snapshot.value.testUrl : DEFAULT_TEST_URL
  const storedLocalDirect = snapshot.value?.localDirect !== false
  const globalTestUrl = typeof globalDraft.testUrl === 'string' ? globalDraft.testUrl : storedTestUrl
  const globalLocalDirect =
    typeof globalDraft.localDirect === 'boolean' ? globalDraft.localDirect : storedLocalDirect
  const globalTestUrlHint = testUrlHint(globalTestUrl, t)
  const globalBlock = h(
    'details',
    {
      className: styles.diag,
      style: {
        ...S.diag,
        marginTop: '0',
      },
      key: 'global-settings',
    },
    h('summary', { className: styles.diagSummary }, t.globalTitle),
    h('p', { className: styles.defaultLead, style: S.defaultLead }, t.globalLead),
    h(
      'label',
      { className: styles.field, style: S.field },
      h('span', { className: styles.label, style: S.label }, t.testUrl),
      h('input', {
        className: styles.input,
        style: S.input,
        value: globalTestUrl,
        onChange: (event: any) => bindGlobal('testUrl')(event.target.value),
      }),
      globalTestUrlHint === undefined
        ? h('span', { style: S.hint }, t.testUrlHint)
        : h(
            'span',
            {
              className: styles.hint,
              style: {
                ...S.hint,
                color: 'var(--dsw-alias-state-error-primary, #f85149)',
              },
            },
            globalTestUrlHint,
          ),
    ),
    h(
      'div',
      { style: S.testRow },
      h(
        'button',
        {
          className: styles.testButton,
          style: S.testButton,
          type: 'button',
          onClick: () => bindGlobal('testUrl')(DEFAULT_TEST_URL),
        },
        t.restoreDefaultTestUrl,
      ),
    ),
    h(
      'label',
      { className: styles.toggle, style: S.toggle },
      h('input', {
        type: 'checkbox',
        checked: globalLocalDirect,
        onChange: (event: any) => bindGlobal('localDirect')(event.target.checked === true),
      }),
      h('span', null, t.localDirect),
    ),
    h(
      'p',
      { style: S.hint },
      globalLocalDirect ? t.localDirectOnHint : t.localDirectOffHint,
    ),
  )

  const query = filter.trim().toLowerCase()
  const shown =
    query.length === 0
      ? rows
      : rows.filter(row => `${row.id} ${row.name}`.toLowerCase().includes(query))
  const filterRow =
    rows.length === 0
      ? null
      : field(
          t.filterLabel,
          h('input', {
            className: styles.input,
            style: S.input,
            placeholder: t.filterPlaceholder,
            value: filter,
            onChange: (event: any) => setFilter(event.target.value),
          }),
        )

  // The empty slot answers three different questions: still loading, the read
  // failed, or truly nothing to show. Only the last is the empty message.
  // With saved cards present, a failed first read is reported above them instead.
  const catalogueStatus = rows.length === 0
    ? state.pending
      ? { text: t.catalogueLoading, error: false }
      : state.error !== undefined
        ? { text: `${t.catalogueError}${state.error}`, error: true }
        : undefined
    : undefined
  const catalogueNotice =
    state.error !== undefined && rows.length > 0
      ? h(
          'p',
          { key: 'catalogue-error', style: S.inheritWarning },
          `${t.catalogueStale}${state.error}`,
        )
      : null

  // ALWAYS an array: a single element is not iterable, and spreading one threw
  // "Spread syntax requires ...iterable[Symbol.iterator]" on an empty list.
  const body: unknown[] = shown.length === 0
    ? [
        h(
          'p',
          {
            className: styles.empty,
            key: 'empty',
            style: {
              margin: '0',
              padding: '16px',
              border: '1px dashed var(--dsw-alias-border-l1)',
              borderRadius: '8px',
              fontSize: '12px',
              textAlign: 'center',
              color: catalogueStatus?.error === true
                ? 'var(--dsw-alias-state-error-primary, #f85149)'
                : 'var(--dsw-alias-state-idle-primary)',
              ...(catalogueStatus?.error === true ? { fontWeight: '500' } : {}),
            },
          },
          catalogueStatus?.text ?? (query.length > 0 ? t.noMatch : t.empty),
        ),
      ]
    : shown.map(row => {
        // The MERGED value, so a just-typed value shows immediately.
        const route = view({ ...configured[row.id], ...draft[row.id] })
        // The endpoint controls are editable whether or not the route is on: the
        // point of the self-check below is to verify a setting BEFORE switching
        // it on, which is impossible if the fields can only be typed into while
        // traffic is already flowing through them. `enabled` gates routing only.
        // The line exists only once a route has actually carried a request, so an
        // ENABLED route with no record yet says so — otherwise a missing line is
        // indistinguishable from the feature not existing. A disabled route stays
        // silent: it cannot have a record, and saying so on every off card is noise.
        const lastText = lastUseText(row.id) ?? (route.enabled ? t.noRecord : undefined)
        const result = tests[row.id]
        // Rule entries that can never match: flagged under the input instead of
        // failing silently — a dead `onlyHosts` entry means fail-closed sends
        // the traffic DIRECT while the user believes it is proxied.
        const onlyDead = deadRuleEntries(route.onlyHosts)
        const bypassDead = deadRuleEntries(route.bypassHosts)
        const useDefault = route.useDefault === true
        // Whether this card has an endpoint worth checking: an inheriting card
        // depends on the shared default being configured, an own-endpoint card on
        // its host and port being complete. Mirrors the Host's own build gate.
        const endpointStored = route.useDefault
          ? defaultComplete
          : route.host.trim().length > 0 &&
            Number.isInteger(route.port) &&
            route.port >= 1 &&
            route.port <= 65535
        const showTest = route.enabled || endpointStored
        // The Host's recorded problem is authoritative (it also covers dispatcher
        // construction); until the next catalogue poll, the shared predicate can
        // already prove the common endpoint mistakes. An unused route is never
        // "rejected" — it has not asked for anything yet.
        const problemText = ((): string | undefined => {
          const recorded = problems[row.id]
          if (recorded !== undefined) return recorded
          if (useDefault) return defaultComplete ? undefined : `${t.defaultMissing}${defaultWhy}`
          return route.enabled ? defaultProxyProblem(route) : undefined
        })()
        const rejected = route.enabled && problemText !== undefined
        // Built once and either rendered (this route carries its own address) or
        // replaced by a one-line note (it inherits the shared default), so a card
        // can never show an input that does not apply to it.
        const endpointFields = [
          field(
            t.protocol,
            h(
              'select',
              {
                className: styles.input,
                style: S.input,
                value: route.protocol,
                onChange: (event: any) => bind(row.id, 'protocol')(event.target.value),
              },
              ...PROTOCOLS.map(protocol =>
                h('option', { key: protocol, value: protocol }, protocol.toUpperCase()),
              ),
            ),
            route.protocol === 'socks5' ? t.socks5Hint : undefined,
          ),
          field(
            t.host,
            h('input', {
              className: styles.input,
              style: S.input,
              placeholder: '127.0.0.1',
              value: route.host,
              onChange: (event: any) => bind(row.id, 'host')(event.target.value),
              // A pasted full proxy URL fills every transport field at once.
              onPaste: onProxyUrlPaste(parts => applyCardUrl(row.id, parts)),
            }),
            t.hostHint,
          ),
          field(
            t.port,
            h('input', {
              className: styles.input,
              style: S.input,
              type: 'number',
              min: 1,
              max: 65535,
              placeholder: '7890',
              value: route.port === 0 ? '' : String(route.port),
              onChange: (event: any) => {
                const parsed = Number.parseInt(event.target.value, 10)
                bind(row.id, 'port')(Number.isNaN(parsed) ? 0 : parsed)
              },
            }),
          ),
          field(
            t.username,
            h('input', {
              className: styles.input,
              style: S.input,
              autocomplete: 'off',
              value: route.username,
              onChange: (event: any) => bind(row.id, 'username')(event.target.value),
            }),
          ),
          // Every transport accepts a password: SOCKS5 hands it to
          // Socks5ProxyAgent as an option, HTTP/HTTPS embed it in the proxy URL
          // userinfo (undici turns that into Proxy-Authorization). It is stored on
          // the route, so it lands in the settings file with the rest of the
          // config; the diagnostics only ever surface a credential-free origin.
          field(
            t.password,
            h('input', {
              className: styles.input,
              style: S.input,
              type: 'password',
              autocomplete: 'off',
              value: route.password,
              onChange: (event: any) => bind(row.id, 'password')(event.target.value),
            }),
            route.protocol === 'socks5' ? t.passwordHint : t.passwordHintProxy,
          ),
        ]
        // The pill describes the ROUTE, never provider availability: a saved
        // route can outlive the Host directory, and whether that directory lists
        // it must not make the proxy switch read as "offline" or "proxied".
        const pill = rejected
          ? { className: styles.pillRejected, style: { ...S.pill, ...S.pillRejected }, text: t.rejected }
          : route.enabled
            ? { className: styles.pillOn, style: { ...S.pill, ...S.pillOn }, text: t.on }
            : { className: styles.pillLive, style: { ...S.pill, ...S.pillLive }, text: t.off }
        return h(
          'section',
          {
            className: rejected ? styles.cardRejected : route.enabled ? styles.cardActive : styles.card,
            style: rejected
              ? { ...S.card, ...S.cardRejected }
              : route.enabled
                ? { ...S.card, ...S.cardActive }
                : S.card,
            key: row.id,
          },
          h(
            'header',
            { className: styles.cardHead, style: S.head },
            h(
              'div',
              { className: styles.cardTitles, style: S.titles },
              h('span', { className: styles.name, style: S.name }, row.name),
              h('span', { className: styles.id, style: S.id }, row.id),
              // A disabled route can never have hits, so "0" there would only add
              // noise; the count shows once the route is on (or has counted).
              route.enabled || (hits[row.id] ?? 0) > 0
                ? h(
                    'span',
                    { style: S.hits },
                    `${t.hitCountPrefix}${hits[row.id] ?? 0}${t.hitCountSuffix}`,
                  )
                : null,
              // The last-use line. A failure takes the error colour, same rule as
              // a failed self-check: it is an answer, not decoration.
              lastText === undefined
                ? null
                : h(
                    'span',
                    {
                      style: {
                        ...S.hits,
                        ...(lastUse[row.id]?.ok === false ? S.inheritWarning : {}),
                      },
                    },
                    lastText,
                  ),
            ),
            h('span', { className: pill.className, style: pill.style }, pill.text),
          ),
          h(
            'label',
            { className: styles.toggle, style: S.toggle },
            h('input', {
              type: 'checkbox',
              checked: route.enabled,
              onChange: (event: any) => bind(row.id, 'enabled')(event.target.checked === true),
            }),
            h('span', null, t.useProxy),
          ),
          // Opting into the shared endpoint. The card then shows the address it
          // will actually use — or, when the default is not configured, why the
          // route is refused — instead of a set of empty inputs the user never
          // filled and cannot interpret.
          h(
            'label',
            { className: styles.toggle, style: S.toggle, key: `${row.id}:usedefault` },
            h('input', {
              type: 'checkbox',
              checked: useDefault,
              onChange: (event: any) => bind(row.id, 'useDefault')(event.target.checked === true),
            }),
            h('span', null, t.useDefault),
          ),
          problemText !== undefined
            ? h('p', { key: `${row.id}:problem`, style: S.inheritWarning }, problemText)
            : useDefault
              ? h(
                  'p',
                  { key: `${row.id}:inherit`, style: S.inheritNote },
                  `${t.inheritingDefault}${defaultOrigin}`,
                )
              : null,
          ...(useDefault ? [] : endpointFields),
          // The self-check is offered whenever there is something to check: an
          // enabled route (the Host's table carries it, and a rejected one still
          // reports WHY), or a disabled one whose endpoint is already complete —
          // the Host builds that one for the check alone. A disabled route with
          // no endpoint has nothing to test and would only answer "not enabled".
          showTest
            ? h(
                'div',
                { style: S.testRow, key: `${row.id}:test` },
                // A check on a route that is still off is a trial run, and it says
                // so — otherwise the result reads as though the route were live.
                route.enabled ? null : h('span', { style: S.testResult }, t.testDisabledNote),
                h(
                  'button',
                  {
                    className: styles.testButton,
                    style: S.testButton,
                    type: 'button',
                    disabled: result?.pending === true,
                    onClick: () => runTest(row.id),
                  },
                  result?.pending === true ? t.testRunning : t.testButton,
                ),
                result?.pending === false
                  ? h(
                      'span',
                      { style: S.testResult },
                      result.ok === true
                        ? [
                            // Only the latency carries the band colour; the exit IP
                            // stays in the secondary label colour.
                            h(
                              'span',
                              { key: 'lat', style: { color: latencyColor(result.ms) } },
                              `✓ ${typeof result.ms === 'number' ? result.ms : '—'} ms`,
                            ),
                            result.ip === undefined ? null : ` · ${t.exitIpLabel}${result.ip}`,
                            result.direct === true ? ` · ${t.directLabel}` : null,
                          ]
                        : h('span', { key: 'err', style: S.testFailure }, `✗ ${result.error}`),
                    )
                  : null,
                // Promote this card's endpoint to the shared default. Offered only
                // when the card carries its OWN endpoint: an inheriting card would
                // just be copying the default onto itself.
                endpointStored && !useDefault
                  ? h(
                      'button',
                      {
                        className: styles.testButton,
                        style: S.testButton,
                        type: 'button',
                        onClick: () => promoteToDefault(row.id),
                      },
                      t.setAsDefault,
                    )
                  : null,
              )
            : null,
          // Target-host rules, collapsed so the common case stays one short card.
          h(
            'details',
            { style: S.advanced, key: `${row.id}:rules` },
            h('summary', { style: S.advancedSummary }, t.advanced),
            field(
              t.onlyHosts,
              h('input', {
                className: styles.input,
                style: S.input,
                placeholder: 'api.example.com',
                value: route.onlyHosts,
                onChange: (event: any) => bind(row.id, 'onlyHosts')(event.target.value),
              }),
              onlyDead.length === 0 ? t.onlyHostsHint : `${t.ruleDeadHint}${onlyDead.join('、')}`,
              onlyDead.length > 0,
            ),
            field(
              t.bypassHosts,
              h('input', {
                className: styles.input,
                style: S.input,
                placeholder: 'localhost',
                value: route.bypassHosts,
                onChange: (event: any) => bind(row.id, 'bypassHosts')(event.target.value),
              }),
              bypassDead.length === 0 ? t.bypassHostsHint : `${t.ruleDeadHint}${bypassDead.join('、')}`,
              bypassDead.length > 0,
            ),
            // The self-check target: empty uses the top-level testUrl, set makes
            // this card's Test request this URL — a real upstream proves the whole
            // path, not just the proxy hop.
            field(
              t.testTarget,
              h('input', {
                className: styles.input,
                style: S.input,
                placeholder: 'https://api.example.com',
                value: route.testTarget,
                onChange: (event: any) => bind(row.id, 'testTarget')(event.target.value),
              }),
              t.testTargetHint,
            ),
          ),
        )
      })

  return h(
    'div',
    { className: styles.root, style: S.root },
    h('p', { className: styles.lead, style: { margin: '0 0 4px', fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary)' } }, t.lead),
    saveError === undefined
      ? null
      : h(
          'div',
          {
            role: 'alert',
            key: 'save-error',
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: '10px',
              padding: '8px 10px',
              border: '1px solid var(--dsw-alias-state-error-primary, #f85149)',
              borderRadius: '8px',
              background: 'var(--dsw-alias-bg-layer-1)',
              color: 'var(--dsw-alias-state-error-primary, #f85149)',
              fontSize: '12px',
              fontWeight: '500',
              wordBreak: 'break-all',
            },
          },
          h('span', null, `${t.saveFailedPrefix}${saveError.label} — ${saveError.message}`),
          h(
            'button',
            {
              className: styles.testButton,
              style: { ...S.testButton, flex: 'none' },
              type: 'button',
              onClick: () => setSaveError(undefined),
            },
            t.close,
          ),
        ),
    defaultBlock,
    globalBlock,
    catalogueNotice,
    filterRow,
    ...body,
    h(
      'details',
      {
        className: styles.diag,
        key: 'diag',
        style: {
          marginTop: '4px',
          padding: '8px 10px',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '8px',
          fontSize: '11px',
          color: 'var(--dsw-alias-label-secondary)',
        },
      },
      // The count is the only visible signal while the panel is collapsed: a
      // rejected route is not a page that refuses to render, it is one that
      // quietly does nothing.
      h(
        'summary',
        { className: styles.diagSummary },
        problemCount === 0 ? t.diagnostics : `${t.diagnostics} (${problemCount})`,
      ),
      h(
        'ul',
        { className: styles.diagList, style: { margin: '6px 0 0', paddingLeft: '18px' } },
        ...(problemCount === 0 && diagnostics.length === 0 && savedNote === undefined
          ? [h('li', { key: 'none' }, t.diagPending)]
          : [
              ...problemLines,
              ...(savedNote === undefined ? [] : [h('li', { key: 'saved' }, savedNote)]),
              ...diagnostics.map((line, index) => h('li', { key: `d${index}` }, line)),
            ]),
      ),
    ),
  )
}

const EN = {
  lead: 'Route selected model providers through your own forward proxy. Other providers stay direct. Requests to loopback or private addresses (localhost, 127.x, private ranges) go direct by default; set the top-level localDirect to false to proxy them instead — a forward proxy normally cannot reach your own machine.',
  empty: 'No providers found yet.',
  catalogueLoading: 'Loading providers…',
  catalogueError: 'Could not load the provider list: ',
  catalogueStale: 'Could not load the provider list; showing the saved configuration: ',
  useProxy: 'Use a proxy for this provider',
  useDefault: 'Use the default proxy',
  defaultTitle: 'Default proxy',
  defaultLead: 'One endpoint, reused by every provider that turns on "Use the default proxy". The status only reports configuration completeness; use the Test button on a card to verify reachability.',
  inheritingDefault: 'Using the default proxy: ',
  defaultMissing: 'The default proxy configuration is incomplete, so this provider is not proxied: ',
  filterLabel: 'Filter',
  filterPlaceholder: 'Filter by name or id…',
  noMatch: 'No provider matches the filter.',
  setAsDefault: 'Set as the default proxy',
  applyDefaultAll: 'Use the default proxy for all providers',
  protocol: 'Type',
  host: 'IP / host',
  port: 'Port',
  username: 'Username',
  password: 'Password',
  hostHint: 'Only an IPv4, IPv6, or domain name is allowed. A full proxy URL (socks5://user:pass@host:1080) can be pasted instead — it is split into the fields.',
  passwordHint: 'Sent to the SOCKS5 proxy for authentication; stored with this setting.',
  passwordHintProxy: 'Sent to the proxy as an authentication password; stored with this setting.',
  hitCountPrefix: '',
  hitCountSuffix: ' proxied',
  recentOk: 'last ok ',
  recentFail: 'last failure ',
  recentStarted: 'last call ',
  noRecord: 'no proxied request yet',
  justNow: 'just now',
  minutesAgo: ' min ago',
  hoursAgo: ' h ago',
  daysAgo: ' d ago',
  testButton: 'Test',
  testRunning: 'Testing…',
  testDisabledNote: 'Not enabled — test only: ',
  testFailed: 'Test failed',
  exitIpLabel: 'exit IP ',
  directLabel: 'direct (not through the proxy)',
  globalTitle: 'Global settings (advanced)',
  globalLead: 'These fields are saved with the plugin rather than per provider. Leave testUrl empty to use the built-in default; comma/space separated candidates are tried in order and only the first 5 are used. localDirect is on by default; turn it off only when the proxy itself is a loopback or private target.',
  testUrl: 'Self-check URL',
  testUrlHint: 'Comma/space separated; http(s) URLs in the order they should be tried.',
  testUrlEmptyHint: 'Empty means the Host uses its built-in default URL.',
  testUrlInvalidHint: 'Some candidates are not absolute http(s) URLs. They are saved, but those checks will fail.',
  testUrlTooManyHint: 'More than 5 candidates are listed; only the first 5 take effect.',
  restoreDefaultTestUrl: 'Restore default',
  localDirect: 'Loopback / private targets go direct',
  localDirectOnHint: 'On: localhost, 127.x and private ranges bypass the proxy.',
  localDirectOffHint: 'Off: loopback/private targets also use the proxy. Enable only when the proxy itself is the target.',
  advanced: 'Advanced: target host rules',
  onlyHosts: 'Proxy only',
  onlyHostsHint: 'Comma/space separated; when set, only requests to these hosts are proxied (suffix match, * for all).',
  bypassHosts: 'Bypass',
  bypassHostsHint: 'Comma/space separated; requests to these hosts go direct, taking priority.',
  ruleDeadHint: 'These entries never match — rules take host names only, without scheme or path: ',
  testTarget: 'Self-check target',
  testTargetHint: 'Empty uses the top-level testUrl; when set, this card\'s Test requests this URL instead — point it at a real upstream to verify the end-to-end path.',
  socks5Hint: 'SOCKS5 tunnels the connection; the proxy resolves the target host name.',
  on: 'proxied',
  rejected: 'config rejected',
  off: 'direct',
  complete: 'complete',
  notConfigured: 'not configured',
  diagnostics: 'Connection diagnostics',
  diagPending: '(collecting…)',
  saveFailedPrefix: 'Save failed: ',
  close: 'Close',
}

const ZH = {
  lead: '让指定的 provider 走你自己的正向代理，其它 provider 保持直连。指向本机或内网地址（localhost、127.x、私有网段）的请求默认直连，顶层 localDirect 设为 false 时恢复走代理——正向代理通常够不到你自己的机器。',
  empty: '没有检测到任何 provider。',
  catalogueLoading: '正在读取 provider 列表…',
  catalogueError: '读取 provider 列表失败：',
  catalogueStale: 'provider 列表读取失败，下面显示的是已保存的配置：',
  useProxy: '为该 provider 启用代理',
  useDefault: '使用默认代理',
  defaultTitle: '默认代理',
  defaultLead: '为勾选「使用默认代理」的 provider 复用的端点，只填一次。状态只表示配置是否完整；代理是否可达请用卡片上的「测试」验证。',
  inheritingDefault: '使用默认代理：',
  defaultMissing: '顶层默认代理配置不完整，该 provider 不会走代理：',
  filterLabel: '过滤',
  filterPlaceholder: '按名称或 id 过滤…',
  noMatch: '没有匹配的 provider。',
  setAsDefault: '设为默认代理',
  applyDefaultAll: '所有 provider 使用默认代理',
  protocol: '类型',
  host: 'IP / 主机',
  port: '端口',
  username: '用户名',
  password: '密码',
  hostHint: '只允许填写 IPv4、IPv6 或域名；也可以直接粘贴完整代理 URL（如 socks5://user:pass@host:1080），会自动拆分到各字段。',
  passwordHint: '仅作为 SOCKS5 认证口令发送给代理；随该设置一起保存。',
  passwordHintProxy: '作为代理认证口令发送给代理；随该设置一起保存。',
  hitCountPrefix: '已代理 ',
  hitCountSuffix: ' 次',
  recentOk: '最近成功 ',
  recentFail: '最近失败 ',
  recentStarted: '最近调用 ',
  noRecord: '尚无代理记录',
  justNow: '刚刚',
  minutesAgo: ' 分钟前',
  hoursAgo: ' 小时前',
  daysAgo: ' 天前',
  testButton: '测试',
  testRunning: '测试中…',
  testDisabledNote: '未启用，仅测试：',
  testFailed: '测试失败',
  exitIpLabel: '出口 IP ',
  directLabel: '直连（未经过代理）',
  globalTitle: '全局设置（高级）',
  globalLead: '这里的两项属于插件全局设置。testUrl 留空时 Host 使用内置默认值；多个候选用逗号或空格分隔，按顺序回退，只有前 5 个生效。localDirect 默认开启；只有代理本身就是本机或内网目标时才需要关闭。',
  testUrl: '自检地址',
  testUrlHint: '逗号或空格分隔；按顺序尝试的 http(s) URL。',
  testUrlEmptyHint: '留空时 Host 使用内置默认地址。',
  testUrlInvalidHint: '部分候选不是绝对的 http(s) URL。仍会保存，但这些候选会测试失败。',
  testUrlTooManyHint: '候选超过 5 个，只有前 5 个生效。',
  restoreDefaultTestUrl: '恢复默认',
  localDirect: '本机 / 内网目标直连',
  localDirectOnHint: '开启：localhost、127.x 与私有网段绕过代理。',
  localDirectOffHint: '关闭：本机 / 内网目标也走代理；仅在代理本身就是目标时使用。',
  advanced: '高级：目标域名规则',
  onlyHosts: '仅走代理',
  onlyHostsHint: '逗号或空格分隔；非空时只有匹配这些主机的请求走代理（后缀匹配，* 表示全部）。',
  bypassHosts: '直连',
  bypassHostsHint: '逗号或空格分隔；匹配这些主机的请求直连，优先于上一项。',
  ruleDeadHint: '以下条目永远匹配不上——规则只认主机名，不要带协议前缀或路径：',
  testTarget: '自检目标',
  testTargetHint: '留空用顶层 testUrl；填写后该卡片的「测试」改为请求这个地址，可拿真实上游验证端到端路径。',
  socks5Hint: 'SOCKS5 会建立隧道，目标域名由代理端解析。',
  on: '走代理',
  rejected: '配置被拒',
  off: '直连',
  complete: '配置完整',
  notConfigured: '未配置',
  diagnostics: '连接诊断',
  diagPending: '（正在收集…）',
  saveFailedPrefix: '保存失败：',
  close: '关闭',
}

/**
 * Pick the dictionary for this render.
 *
 * The shell's own locale dictionary wins when it carries a translated entry, so
 * the page follows the application language instead of second-guessing it.
 * Chinese is the fallback because that is the operator's language.
 */
function stringsFor(ctx: any): Record<string, string> {
  const language = localeOf(ctx)
  const bundled = language === 'zh' ? ZH : EN
  const translated = ((): Record<string, string> | undefined => {
    try {
      const service = optionalService(ctx, 'locale')
      const bound = service?.bind?.('dshProviderProxy')
      const value = typeof bound === 'function' ? bound('title') : undefined
      if (typeof value === 'string' && value.length > 0) return { title: value } as never
    } catch {
      // no locale dictionary available
    }
    return undefined
  })()
  return { ...bundled, ...(translated ?? {}) }
}

/**
 * The client module system's resolver.
 *
 * The loader calls `factory(require)` and that parameter shadows Node's
 * `require` inside the emitted CJS, so this describes the module-table
 * resolver, not Node's.
 */
declare function require(specifier: string): unknown
