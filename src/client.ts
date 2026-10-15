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

type Protocol = 'http' | 'https' | 'socks5'

type RouteValue = {
  enabled: boolean
  protocol: Protocol
  host: string
  port: number
  username: string
  password: string
  onlyHosts: string
  bypassHosts: string
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
        label: () => (localeOf(ctx) === 'zh' ? 'Provider 代理' : 'Provider 代理'),
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
  for (const row of published) {
    if (row.live) rows.set(row.id, row)
  }
  for (const [id, route] of Object.entries(configured)) {
    if (rows.has(id)) continue
    rows.set(id, { id, name: id, live: route?.enabled === true })
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
    error: ok
      ? undefined
      : typeof body?.error === 'string' && body.error.length > 0
        ? body.error
        : strings.testFailed,
  }
}

/**
 * The setter the lazy catalogue initializer resolves through.
 *
 * It is republished after every render, so the newest one always wins, and a
 * promise that settles after an unmount writes to a harmless no-op.
 */
let catalogueSetter: ((catalog: Catalog) => void) | undefined = () => {}

/** What the Host endpoint publishes: provider rows, hit counts, rejected routes. */
type Catalog = {
  rows: ProviderRow[]
  hits: Record<string, number>
  problems: Record<string, string>
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
  return { rows, hits, problems }
}

const byName = (a: ProviderRow, b: ProviderRow): number => a.name.localeCompare(b.name)

function view(route: Partial<RouteValue> | undefined): RouteValue {
  return {
    enabled: route?.enabled === true,
    protocol: PROTOCOLS.includes(route?.protocol as Protocol) ? (route!.protocol as Protocol) : 'http',
    host: route?.host ?? '',
    port: route?.port ?? 0,
    username: route?.username ?? '',
    password: route?.password ?? '',
    onlyHosts: route?.onlyHosts ?? '',
    bypassHosts: route?.bypassHosts ?? '',
  }
}

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
        note(`provider 列表获取失败：${error?.message ?? error}`)
        catalogueSetter?.({ rows: [], hits: {}, problems: {} })
      })
    return {
      rows: undefined as ProviderRow[] | undefined,
      hits: {} as Record<string, number>,
      problems: {} as Record<string, string>,
      pending: true,
    }
  })
  // The setter is published right after the hook so the initializer's promise
  // can reach it. It is re-published on every render, so the latest wins.
  catalogueSetter = catalog =>
    setState({ rows: catalog.rows, hits: catalog.hits, problems: catalog.problems, pending: false })

  const published = state.rows ?? []
  const hits = state.hits ?? {}
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

  // Self-check outcomes keyed by provider id: `{ pending: true }` while the Host
  // is testing, then the normalized result the card renders.
  const [tests, setTests] = (React.useState ?? ((v: any) => [v, () => {}]))({})

  /**
   * Run the Host's self-check for one provider.
   *
   * The check is not routed traffic, so it never changes the hit count; the count
   * on the card is read at mount and stays put until the page reloads.
   */
  const runTest = (id: string): void => {
    setTests((current: any) => ({ ...current, [id]: { pending: true } }))
    void (async () => {
      try {
        const response = await globalThis.fetch(TEST_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ provider: id }),
        })
        const body = await response.json()
        setTests((current: any) => ({ ...current, [id]: testResultFrom(body, t) }))
      } catch (error: any) {
        setTests((current: any) => ({
          ...current,
          [id]: { pending: false, ok: false, error: String(error?.message ?? error) },
        }))
      }
    })()
  }

  const rows = knownProviders({ ...configured, ...draft }, published)

  /**
   * Persist one field. The control is already showing the new value, so this
   * only has to succeed quietly; a refusal is reported in the diagnostics.
   */
  const save = (id: string, field: string, value: unknown) => {
    void writeConfig(ctx, [{ op: 'set', path: ['providers', id, field], value }])
      .then(() => {
        note(`已保存 ${id}.${field} = ${JSON.stringify(value)}`)
      })
      .catch((error: any) => {
        note(`保存失败 ${id}.${field}：${error?.message ?? error}`)
        // Drop the optimistic value so the stored state shows through again.
        setDraft((current: any) => {
          const next = { ...current }
          delete next[id]
          return next
        })
      })
  }

  /** One control: update the draft instantly, persist in the background. */
  const bind = (id: string, field: string) => (value: unknown) => {
    edit(id, field, value)
    save(id, field, value)
  }

  const field = (label: string, control: unknown, hint?: string): unknown =>
    h(
      'label',
      { className: styles.field, style: S.field, key: label },
      h('span', { className: styles.label, style: S.label }, label),
      control,
      hint === undefined
        ? null
        : h(
            'span',
            { className: styles.hint, style: { gridColumn: '2', fontSize: '11px' } },
            hint,
          ),
    )

  // ALWAYS an array: a single element is not iterable, and spreading one threw
  // "Spread syntax requires ...iterable[Symbol.iterator]" on an empty list.
  const body: unknown[] = rows.length === 0
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
              color: 'var(--dsw-alias-state-idle-primary)',
            },
          },
          t.empty,
        ),
      ]
    : rows.map(row => {
        // The MERGED value, so a just-typed value shows immediately.
        const route = view({ ...configured[row.id], ...draft[row.id] })
        const disabled = !route.enabled
        const result = tests[row.id]
        return h(
          'section',
          {
            className: route.enabled ? styles.cardActive : styles.card,
            style: route.enabled ? { ...S.card, ...S.cardActive } : S.card,
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
            ),
            h(
              'span',
              {
                className: route.enabled ? styles.pillOn : row.live ? styles.pillLive : styles.pillOff,
                style: {
                  ...S.pill,
                  ...(route.enabled ? S.pillOn : row.live ? S.pillLive : S.pillOff),
                },
              },
              route.enabled ? t.on : row.live ? t.live : t.off,
            ),
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
          field(
            t.protocol,
            h(
              'select',
              {
                className: styles.input,
                style: S.input,
                disabled,
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
              disabled,
              placeholder: '127.0.0.1',
              value: route.host,
              onChange: (event: any) => bind(row.id, 'host')(event.target.value),
            }),
            t.hostHint,
          ),
          field(
            t.port,
            h('input', {
              className: styles.input,
              style: S.input,
              disabled,
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
              disabled,
              autocomplete: 'off',
              value: route.username,
              onChange: (event: any) => bind(row.id, 'username')(event.target.value),
            }),
          ),
          // Every transport accepts a password now: SOCKS5 hands it to
          // Socks5ProxyAgent as an option, HTTP/HTTPS embed it in the proxy URL
          // userinfo (undici turns that into Proxy-Authorization). It is stored on
          // the route, so it lands in the settings file with the rest of the
          // config; the diagnostics only ever surface a credential-free origin.
          field(
            t.password,
            h('input', {
              className: styles.input,
              style: S.input,
              disabled,
              type: 'password',
              autocomplete: 'off',
              value: route.password,
              onChange: (event: any) => bind(row.id, 'password')(event.target.value),
            }),
            route.protocol === 'socks5' ? t.passwordHint : t.passwordHintProxy,
          ),
          // The self-check only makes sense for a route that is ON; a disabled
          // route is not in the Host's table, so there is nothing to test.
          route.enabled
            ? h(
                'div',
                { style: S.testRow, key: `${row.id}:test` },
                h(
                  'button',
                  {
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
                          ]
                        : h('span', { key: 'err', style: S.testFailure }, `✗ ${result.error}`),
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
                disabled,
                placeholder: 'api.example.com',
                value: route.onlyHosts,
                onChange: (event: any) => bind(row.id, 'onlyHosts')(event.target.value),
              }),
              t.onlyHostsHint,
            ),
            field(
              t.bypassHosts,
              h('input', {
                className: styles.input,
                style: S.input,
                disabled,
                placeholder: 'localhost',
                value: route.bypassHosts,
                onChange: (event: any) => bind(row.id, 'bypassHosts')(event.target.value),
              }),
              t.bypassHostsHint,
            ),
          ),
        )
      })

  return h(
    'div',
    { className: styles.root, style: S.root },
    h('p', { className: styles.lead, style: { margin: '0 0 4px', fontSize: '12px', lineHeight: '1.6', color: 'var(--dsw-alias-label-secondary)' } }, t.lead),
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
        ...(problemCount === 0 && diagnostics.length === 0
          ? [h('li', { key: 'none' }, t.diagPending)]
          : [
              ...problemLines,
              ...diagnostics.map((line, index) => h('li', { key: `d${index}` }, line)),
            ]),
      ),
    ),
  )
}

const EN = {
  lead: 'Route selected model providers through your own forward proxy. Other providers stay direct.',
  empty: 'No providers found yet.',
  useProxy: 'Use a proxy for this provider',
  protocol: 'Type',
  host: 'IP / host',
  port: 'Port',
  username: 'Username',
  password: 'Password',
  hostHint: 'Host or IP only, without scheme or path.',
  passwordHint: 'Sent to the SOCKS5 proxy for authentication; stored with this setting.',
  passwordHintProxy: 'Sent to the proxy as an authentication password; stored with this setting.',
  hitCountPrefix: '',
  hitCountSuffix: ' proxied',
  testButton: 'Test',
  testRunning: 'Testing…',
  testFailed: 'Test failed',
  exitIpLabel: 'exit IP ',
  advanced: 'Advanced: target host rules',
  onlyHosts: 'Proxy only',
  onlyHostsHint: 'Comma/space separated; when set, only requests to these hosts are proxied (suffix match, * for all).',
  bypassHosts: 'Bypass',
  bypassHostsHint: 'Comma/space separated; requests to these hosts go direct, taking priority.',
  socks5Hint: 'SOCKS5 tunnels the connection; the proxy resolves the target host name.',
  on: 'proxied',
  live: 'active',
  off: 'direct',
  diagnostics: 'Connection diagnostics',
  diagPending: '(collecting…)',
}

const ZH = {
  lead: '让指定的 provider 走你自己的正向代理，其它 provider 保持直连。',
  empty: '没有检测到任何 provider。',
  useProxy: '为该 provider 启用代理',
  protocol: '类型',
  host: 'IP / 主机',
  port: '端口',
  username: '用户名',
  password: '密码',
  hostHint: '只填主机名或 IP，不要带协议前缀或路径。',
  passwordHint: '仅作为 SOCKS5 认证口令发送给代理；随该设置一起保存。',
  passwordHintProxy: '作为代理认证口令发送给代理；随该设置一起保存。',
  hitCountPrefix: '已代理 ',
  hitCountSuffix: ' 次',
  testButton: '测试',
  testRunning: '测试中…',
  testFailed: '测试失败',
  exitIpLabel: '出口 IP ',
  advanced: '高级：目标域名规则',
  onlyHosts: '仅走代理',
  onlyHostsHint: '逗号或空格分隔；非空时只有匹配这些主机的请求走代理（后缀匹配，* 表示全部）。',
  bypassHosts: '直连',
  bypassHostsHint: '逗号或空格分隔；匹配这些主机的请求直连，优先于上一项。',
  socks5Hint: 'SOCKS5 会建立隧道，目标域名由代理端解析。',
  on: '走代理',
  live: '启用中',
  off: '直连',
  diagnostics: '连接诊断',
  diagPending: '（正在收集…）',
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
