// Guards the silent failures that shipped before: a client half that never
// registers, and one that registers but renders nothing. Both are invisible in
// the UI — no error, no request, no entry.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const clientSource = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
const clientCss = readFileSync(new URL('../src/client.css', import.meta.url), 'utf8')
const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  /**
   * A minimal hook backed by ONE state object per render pass.
   *
   * The optimistic-feedback test is meaningless without a stateful `useState`:
   * a no-op setter makes every control look broken, which is exactly the bug it
   * exists to catch. The setter mutates the object and calls `onUpdate`, so the
   * test can re-render explicitly — nothing re-enters render() from inside the
   * setter, which would recurse forever.
   */
  useState(initial) {
    const store = (React.store ??= {})
    const key = React.keyIndex++
    // Seed from `initial` for a fresh key, so the first pass sees the defaults
    // and later passes see whatever the setters wrote.
    if (!(key in store)) store[key] = typeof initial === 'function' ? initial() : initial
    const value = store[key]
    const set = next => {
      store[key] = typeof next === 'function' ? next(store[key]) : next
      React.onUpdate?.()
    }
    return [value, set]
  },
  store: undefined,
  keyIndex: 0,
  keys: [],
  onUpdate: undefined,
  lastRender: undefined,
}

/**
 * Evaluate the bundle the way the client module system does.
 *
 * The whole script is run inside a fresh function scope so that the bundle's
 * MODULE-LEVEL state (the provider-directory cache) is per-load. The real
 * module system evaluates each bundle once per page load and keeps that state
 * for the page's lifetime; evaluating into the shared test scope would leak one
 * test's directory into the next.
 */
function loadBundle(fetchImpl) {
  const styles = []
  const previous = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch }
  globalThis.window = { __ModuleLoader__: { load: o => { globalThis.__reg = o } } }
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, set textContent(v) { styles.push(v) } }),
    head: { appendChild() {} },
  }
  // The page reads the provider catalogue from the Host endpoint, so `fetch`
  // must be stubbed before the bundle runs.
  const requested = []
  globalThis.fetch = fetchImpl ?? (async url => {
    requested.push(url)
    return {
      ok: true,
      status: 200,
      json: async () => ({
        providers: [
          { id: 'sensenova', name: 'SenseNova', live: true },
          { id: 'openai', name: 'OpenAI', live: true },
        ],
      }),
    }
  })
  // eslint-disable-next-line no-new-func
  const factory = new Function('module', 'exports', 'require', 'window', 'document', 'fetch', `
    ${bundle}
    return globalThis.__reg
  `)
  const mod = { exports: {} }
  const reg = factory(
    mod,
    mod.exports,
    spec => (spec === 'react' ? React : {}),
    globalThis.window,
    globalThis.document,
    globalThis.fetch,
  )
  return {
    mod: reg.factory(spec => (spec === 'react' ? React : {})),
    styles,
    requested,
    restore() {
      globalThis.window = previous.window
      globalThis.document = previous.document
      globalThis.fetch = previous.fetch
      delete globalThis.__reg
    },
  }
}

/**
 * A faithful stand-in for a Cordis client context.
 *
 * The real one THROWS `cannot get property "X" without inject` when a fiber
 * touches a service it did not declare. A plain object returns undefined
 * instead, which is why an earlier version of these tests passed while the app
 * crashed on every render. `ctx` is therefore a Proxy that enforces the
 * `inject` list exactly as Cordis does.
 *
 * `configForms` carries the settings form; the provider catalogue arrives in
 * the form's own value, published by the Host half (this release has no
 * client-facing LLM service).
 */
function makeCtx(snapshotOverrides = {}) {
  const registrations = []
  const writes = []
  // The page lists exactly the providers it has a route for; this release
  // exposes no client-facing LLM service, so nothing enumerates the rest.
  const snapshot = {
    value: {
      providers: {
        sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890, username: '', password: '' },
        openai: { enabled: false, protocol: 'http', host: '', port: 0, username: '', password: '' },
      },
    },
    revision: 7,
    ...snapshotOverrides,
  }
  const form = {
    getSnapshot: () => snapshot,
    mutate: async (ops, revision) => { writes.push({ ops, revision }) },
  }
  const configForms = { get: id => (id === 'provider-proxy' ? form : undefined) }
  const slots = {
    inject: (_name, cb) => { cb(); return () => {} },
    register: (decl, Component) => { registrations.push({ decl, Component }); return () => {} },
  }

  const declared = new Set()
  // `ctx.get` is Cordis's NON-throwing optional lookup. Services obtained
  // through it are usable without being declared in `inject`, which is the only
  // safe way to reach an integration this release may not provide.
  const services = new Map([['configForms', configForms]])
  const target = {
    slots,
    locale: { getSnapshot: () => ({ locale: 'zh' }) },
    get: name => services.get(name),
  }
  const ctx = new Proxy(target, {
    get(base, prop) {
      if (prop === 'get') return base.get
      if (prop === 'configForms') {
        if (!declared.has('configForms')) {
          throw new Error('cannot get property "configForms" without inject')
        }
        return configForms
      }
      if (prop === 'settingsScope') {
        // This release has none. Declaring it left the fiber PENDING and failed
        // the whole Desktop boot, so touching it must throw.
        throw new Error('cannot get property "settingsScope" without inject')
      }
      if (prop === 'remote' || prop === 'llm') {
        // This release exposes neither; touching one must throw, which is
        // exactly what the in-page diagnostics reported.
        throw new Error(`cannot get property "${String(prop)}" without inject`)
      }
      if (prop in base) return base[prop]
      throw new Error(`cannot get property "${String(prop)}" without inject`)
    },
  })
  return {
    ctx,
    registrations,
    writes,
    snapshot,
    form,
    services,
    /** The plugin declares its inject list at apply() time, as Cordis does. */
    declare(servicesList) { for (const s of servicesList) declared.add(s) },
  }
}

/**
 * Apply the plugin the way Cordis does: declare the module's own inject list on
 * the fiber FIRST, then run apply(). Omitting that is what let a build that
 * crashed in the browser pass here.
 */
function mountPlugin(mod, remoteOverrides) {
  const harness = makeCtx(remoteOverrides)
  harness.declare(mod.inject)
  mod.apply(harness.ctx)
  return harness
}

/**
 * Mount the page and return a `render()` that re-invokes the component.
 *
 * Optimistic UI cannot be tested with a stateless `useState`: the setter would
 * do nothing and every control would look broken. The hook store is created
 * ONCE here and kept, so a value written by a setter survives into the next
 * render — that persistence is the behaviour under test. The newest tree is
 * also left on `React.lastRender`.
 *
 * Returns `[firstTree, render]`: the tree from the mounting pass, and a stable
 * `render()` bound to the SAME hook store.
 */
function renderPage(mod, harness) {
  const component = harness.registrations[0].Component
  React.store = {}
  React.keyIndex = 0
  const render = () => {
    React.keyIndex = 0
    const tree = component()
    React.lastRender = tree ?? React.lastRender
    return tree
  }
  return [render(), render]
}

function textsOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (Array.isArray(node)) { node.forEach(n => textsOf(n, out)); return out }
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (node.children) textsOf(node.children, out)
  return out
}

function findCheckbox(node) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const n of node) { const found = findCheckbox(n); if (found) return found }
    return undefined
  }
  if (node.props?.type === 'checkbox') return node
  return node.children ? findCheckbox(node.children) : undefined
}

function findCheckboxes(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(n => findCheckboxes(n, out)); return out }
  if (node.props?.type === 'checkbox') out.push(node)
  if (node.children) findCheckboxes(node.children, out)
  return out
}

/**
 * The `<section>` card whose texts include one provider id.
 *
 * Needed because the page now renders a shared-default block ABOVE the cards,
 * and that block carries host/port inputs with the same placeholders the cards
 * use. A search by placeholder alone would land in the default block instead of
 * the card under test.
 */
function cardFor(tree, id) {
  const sections = []
  const walk = node => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'section') sections.push(node)
    if (node.children) walk(node.children)
  }
  walk(tree)
  return sections.find(section => textsOf(section).includes(id))
}

test('the bundle registers a settings section', () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations } = mountPlugin(mod)
    assert.equal(registrations.length, 1)
    assert.equal(registrations[0].decl.name, 'settings.section')
    assert.equal(registrations[0].decl.id, 'provider-proxy')
    assert.equal(typeof registrations[0].decl.label, 'function', 'the nav entry needs a label')
  } finally {
    restore()
  }
})

test('only services that actually exist are declared', () => {
  // A declared service that never appears leaves the fiber PENDING forever and
  // fails the whole boot with
  //   web boot: 1 entry did not activate
  //   dsh-provider-proxy: pending (waiting for service: settingsScope)
  // which is exactly what this release does to `settingsScope` and
  // `configForms`. Neither may appear in `inject`.
  const LIVE_CLIENT_SERVICES = [
    'layout', 'locale', 'sessions', 'slots', 'theme', 'timer', 'uiWorkspace', 'workspaces',
  ]
  const { mod, restore } = loadBundle()
  try {
    for (const service of mod.inject) {
      assert.ok(
        LIVE_CLIENT_SERVICES.includes(service),
        `"${service}" is not a live client service; declaring it fails the Desktop boot`,
      )
    }
    assert.deepEqual([...mod.inject].sort(), ['slots'])
  } finally {
    restore()
  }
})

test('the manifest requests the client remotes it declares', () => {
  // An empty `dsh.client.inject` yields an empty ctx.remote, and the page then
  // reports "No providers found yet" even though it registered fine.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const inject = manifest.dsh?.client?.inject ?? []
  assert.ok(Array.isArray(inject) && inject.length > 0, 'dsh.client.inject must request the carriers')
  assert.ok(
    inject.some(name => name.includes('connection')) && inject.some(name => name.includes('ui-settings')),
    `inject must cover the connection and settings carriers, got ${JSON.stringify(inject)}`,
  )
})

/** Let the async provider directory resolve and the re-render run. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
}

/**
 * Wait past the settings-write debounce (WRITE_DELAY_MS = 300 in client.ts).
 *
 * Timers fire no earlier than their delay, so 350 ms guarantees a write that
 * was scheduled has actually been issued.
 */
async function writeSettle() {
  await new Promise(resolve => setTimeout(resolve, 350))
  await settle()
}

/** Find every input carrying one placeholder, anywhere in the tree. */
function findInputsByPlaceholder(node, placeholder, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(n => findInputsByPlaceholder(n, placeholder, out)); return out }
  if (node.props?.placeholder === placeholder && node.type === 'input') out.push(node)
  if (node.children) findInputsByPlaceholder(node.children, placeholder, out)
  return out
}

test('rendering survives a context that forbids undeclared services', async () => {
  // The shipped build crashed with
  //   Error: cannot get property "remote" without inject
  //   at knownProviders (client.ts)
  // because Cordis THROWS on an undeclared service. A plain-object mock returns
  // undefined instead, so this test uses a Proxy that throws like Cordis does.
  const { mod, restore } = loadBundle()
  try {
    const { ctx, registrations, declare } = makeCtx()
    declare(mod.inject)
    mod.apply(ctx)
    assert.doesNotThrow(() => registrations[0].Component(), 'the first render must not throw')
    await settle()
    assert.doesNotThrow(() => registrations[0].Component(), 'the re-render must not throw either')
  } finally {
    restore()
  }
})

test('the page still renders when no settings service exists at all', () => {
  // This release has no configForms/settingsScope. `ctx.get` returns undefined
  // rather than throwing, so the page must degrade to "nothing configured"
  // instead of crashing — and must never declare such a service in `inject`,
  // because that is what failed the Desktop boot.
  const { mod, restore } = loadBundle()
  try {
    const { ctx, registrations, declare, services } = makeCtx()
    services.clear() // no settings service on this fiber at all
    declare(mod.inject)
    mod.apply(ctx)
    const out = registrations[0].Component()
    assert.notEqual(out, null, 'the page must still render with no settings service')
    assert.equal(out.type, 'div')
    assert.ok(textsOf(out).includes('没有检测到任何 provider。'))
  } finally {
    restore()
  }
})

test('a configured provider is listed even when the catalogue omits it', () => {
  const { mod, restore } = loadBundle()
  try {
    // sensenova lives only in `providers`; the Host published no catalogue row.
    const { registrations } = mountPlugin(mod, { value: { providers: { sensenova: { enabled: true, protocol: 'http', host: '', port: 0, username: '', password: '' } }, catalog: {} } })
    const texts = textsOf(registrations[0].Component())
    assert.ok(texts.includes('sensenova'), 'a configured provider is always listed')
  } finally {
    restore()
  }
})

test('the password field appears for every protocol', () => {
  // The field used to be SOCKS5-only; it is now shown for HTTP/HTTPS as well,
  // because those send the password as Proxy-Authorization.
  const render = (protocol: string, port: number) => {
    const { mod, restore } = loadBundle()
    const { registrations } = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: {
            enabled: true,
            protocol,
            host: '127.0.0.1',
            port,
            username: 'alice',
            password: 'hunter2',
          },
        },
      },
      catalog: {},
    })
    const texts = textsOf(registrations[0].Component())
    restore()
    return texts
  }

  assert.ok(render('socks5', 1080).includes('密码'), 'socks5 must offer the password field')
  assert.ok(render('http', 7890).includes('密码'), 'http must offer the password field')
  assert.ok(render('https', 8443).includes('密码'), 'https must offer the password field')
})

test('the stored socks5 password renders into the field', async () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations } = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: 1080, username: '', password: 'hunter2' },
        },
      },
      catalog: {},
    })
    const out = registrations[0].Component()

    // The stored value must reach the input, otherwise a save would overwrite a
    // configured password with an empty one.
    const inputs = JSON.stringify(out)
    assert.ok(inputs.includes('hunter2'), 'the stored password renders into the field')
  } finally {
    restore()
  }
})

test('the page must not touch remote or llm, which do not exist here', () => {
  // The in-page diagnostics reported
  //   cannot get property "remote" without inject
  // so the page may not reach for either namespace.
  const { mod, restore } = loadBundle()
  try {
    const { ctx, registrations, declare } = makeCtx()
    declare(mod.inject)
    mod.apply(ctx)
    // The Proxy in makeCtx THROWS on `remote` and `llm`, so a clean render is
    // proof the page never reads them.
    assert.doesNotThrow(() => registrations[0].Component())
  } finally {
    restore()
  }
})

test('the page RENDERS instead of silently returning null', () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations } = mountPlugin(mod)
    const out = registrations[0].Component()
    assert.notEqual(out, null, 'a null return is silent and invisible')
    assert.equal(out.type, 'div')
  } finally {
    restore()
  }
})

test('the page lists the providers the Host publishes, automatically', async () => {
  const { mod, restore, requested } = loadBundle()
  try {
    const { registrations } = mountPlugin(mod)
    registrations[0].Component()
    await settle()
    const texts = textsOf(registrations[0].Component())
    // Providers come from the Host endpoint — no manual entry, no client service.
    for (const label of ['sensenova', 'openai']) {
      assert.ok(texts.includes(label), `missing provider: ${label}`)
    }
    for (const control of ['为该 provider 启用代理', '类型', 'HTTP', 'HTTPS', 'SOCKS5', '端口', '用户名']) {
      assert.ok(texts.includes(control), `missing control: ${control}`)
    }
    assert.ok(!texts.includes('尚未实现'), 'SOCKS5 is implemented; no stale warning may remain')
    assert.ok(!texts.includes('Add'), 'the user must not type a provider id')
    assert.ok(
      requested.includes('/dsh-provider-proxy/providers'),
      `the page must read the Host endpoint, got ${JSON.stringify(requested)}`,
    )
  } finally {
    restore()
  }
})

test('a route the Host refused is reported in the connection diagnostics', async () => {
  // A rejected route is absent from the provider list, so the panel is the only
  // place that says why — without it the user has to press Test on the card to
  // discover that the setting was refused at all.
  const { mod, restore } = loadBundle(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      providers: [{ id: 'sensenova', name: 'SenseNova', live: true }],
      hits: {},
      problems: { sensenova: '配置了代理用户名但没有密码；请补全密码或清空用户名' },
    }),
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())
    assert.ok(
      texts.includes('sensenova：配置了代理用户名但没有密码；请补全密码或清空用户名'),
      'the refusal reason must be shown next to the provider it belongs to',
    )
    assert.ok(
      JSON.stringify(render()).includes('dsw-alias-state-error-primary'),
      'a refused route takes the error colour',
    )
    assert.ok(texts.includes('连接诊断 (1)'), 'the collapsed panel must announce that it has content')
  } finally {
    restore()
  }
})

test('the page shows how many requests crossed the proxy', async () => {
  const { mod, restore } = loadBundle(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      providers: [{ id: 'sensenova', name: 'SenseNova', live: true }],
      hits: { sensenova: 4 },
    }),
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())
    assert.ok(texts.includes('已代理 4 次'), 'the routed-request count is rendered')
  } finally {
    restore()
  }
})

test('an enabled provider offers the connection self-check', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())
    assert.ok(texts.includes('测试'), 'an enabled provider must offer the self-check button')
  } finally {
    restore()
  }
})

test('a fast self-check latency is rendered in the success colour', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: true, ms: 120, status: 200, exitIp: '1.2.3.4' }
        : { providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    // Scoped to the card: the shared-default block above it renders a button of
    // its own, so a bare findButton would grab that one instead.
    const button = findButton(cardFor(render(), 'sensenova'))
    assert.ok(button, 'the self-check button must be rendered')
    button.props.onClick()
    await settle()
    const tree = JSON.stringify(render())
    assert.ok(tree.includes('120 ms'), 'the latency value is always shown')
    assert.ok(
      tree.includes('dsw-alias-state-success-primary'),
      'a fast latency uses the success colour',
    )
  } finally {
    restore()
  }
})

test('a self-check that went direct says so, instead of reading as a proxy success', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: true, ms: 30, status: 200, viaProxy: false }
        : { providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const button = findButton(cardFor(render(), 'sensenova'))
    assert.ok(button, 'the self-check button must be rendered')
    button.props.onClick()
    await settle()
    const texts = textsOf(render())
    assert.ok(
      texts.some(text => text.includes('直连（未经过代理）')),
      'a direct check must say it never used the proxy, so green is not read as "the proxy works"',
    )
  } finally {
    restore()
  }
})

test('a failed self-check is rendered in the error colour, without the Host-log prefix', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: false, kind: 'proxy-unreachable', error: '代理不可达（ECONNREFUSED）：connect failed' }
        : { providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const button = findButton(cardFor(render(), 'sensenova'))
    assert.ok(button, 'the self-check button must be rendered')
    button.props.onClick()
    await settle()
    const tree = JSON.stringify(render())
    const texts = textsOf(render())
    assert.ok(
      texts.includes('✗ 代理不可达（ECONNREFUSED）：connect failed'),
      'the failure text is rendered verbatim — no prefix, no generic fallback',
    )
    assert.ok(
      tree.includes('dsw-alias-state-error-primary'),
      'a failure is the answer, so it takes the error colour rather than the secondary one',
    )
  } finally {
    restore()
  }
})

test('the cards expose the advanced target-host rules', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())
    assert.ok(texts.includes('高级：目标域名规则'), 'the advanced rules section must be rendered')
    assert.ok(texts.includes('仅走代理'), 'the onlyHosts field must be rendered')
    assert.ok(texts.includes('自检目标'), 'the per-provider testTarget field must be rendered')
  } finally {
    restore()
  }
})

test('a target-host rule entry that can never match is flagged where it is typed', async () => {
  // A malformed entry fails SILENTLY on the Host side: `onlyHosts` with a dead
  // entry means fail-closed sends the traffic DIRECT while the user believes it
  // is proxied. The page must name the offending entry at the input itself.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: {
            enabled: true,
            protocol: 'http',
            host: '10.0.0.1',
            port: 7890,
            username: '',
            password: '',
            onlyHosts: 'https://api.example.com, *.example.com',
            bypassHosts: 'localhost',
          },
          openai: { enabled: false, protocol: 'http', host: '', port: 0, username: '', password: '' },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())

    const warning = texts.find(t => t.includes('永远匹配不上'))
    assert.ok(warning, 'a dead rule entry must be flagged')
    assert.ok(
      warning.includes('https://api.example.com'),
      'the warning names the entry that cannot match',
    )
    assert.ok(
      !warning.includes('*.example.com'),
      'a `*.`-prefixed entry is valid (the Host strips the prefix) and must not be flagged',
    )
    assert.ok(
      !texts.some(t => t.includes('localhost') && t.includes('永远匹配不上')),
      'a well-formed bypass entry keeps the ordinary hint',
    )
  } finally {
    restore()
  }
})

test('a Host that reports no providers degrades to the empty message', async () => {
  const { mod, restore } = loadBundle(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ providers: [] }),
  }))
  try {
    const { registrations } = mountPlugin(mod, { value: { providers: {} } })
    registrations[0].Component()
    await settle()
    assert.ok(textsOf(registrations[0].Component()).includes('没有检测到任何 provider。'))
  } finally {
    restore()
  }
})

test('a failing catalogue endpoint does not break the page', async () => {
  const { mod, restore } = loadBundle(async () => ({ ok: false, status: 500, json: async () => ({}) }))
  try {
    const { registrations } = mountPlugin(mod, { value: { providers: {} } })
    assert.doesNotThrow(() => registrations[0].Component())
    await settle()
    assert.doesNotThrow(() => registrations[0].Component())
  } finally {
    restore()
  }
})

test('an enabled provider is marked proxied, an unconfigured one direct', async () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations } = mountPlugin(mod)
    registrations[0].Component()
    await settle()
    const texts = textsOf(registrations[0].Component())
    assert.ok(texts.includes('走代理'), 'sensenova is enabled in config')
    assert.ok(texts.includes('直连'), 'openai has no route yet')
  } finally {
    restore()
  }
})

test('a provider that is not active is not shown', async () => {
  // Requested behaviour: only ACTIVE routes appear. A provider the deployment
  // merely offers cannot be selected, so offering it a proxy config is noise.
  const { mod, restore } = loadBundle(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      providers: [
        { id: 'sensenova', name: 'SenseNova', live: true },
        { id: 'openai', name: 'OpenAI', live: false },
        { id: 'anthropic', name: 'Anthropic', live: false },
      ],
    }),
  }))
  try {
    const harness = mountPlugin(mod, { value: { providers: {} } })
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())

    assert.ok(texts.includes('sensenova'), 'an active provider must be listed')
    assert.ok(!texts.includes('openai'), 'an inactive provider must be hidden')
    assert.ok(!texts.includes('anthropic'), 'an inactive provider must be hidden')
  } finally {
    restore()
  }
})

test('a configured provider stays visible even if the Host stopped offering it', async () => {
  // A saved proxy setting must never silently vanish: if the route stops being
  // active, the user still needs to see and be able to clear its config.
  const { mod, restore } = loadBundle(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] }),
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())

    assert.ok(texts.includes('sensenova'))
    assert.ok(texts.includes('openai'), 'a provider present in our config must still be listed')
  } finally {
    restore()
  }
})

function findButton(node) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const n of node) { const found = findButton(n); if (found) return found }
    return undefined
  }
  if (node.type === 'button') return node
  return node.children ? findButton(node.children) : undefined
}

/** Every button in a subtree, in document order. */
function findButtons(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(n => findButtons(n, out)); return out }
  if (node.type === 'button') out.push(node)
  if (node.children) findButtons(node.children, out)
  return out
}

test('each provider is rendered as its own card section', async () => {
  // The requested layout: one card per provider, not one merged form.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const tree = render()

    const sections = []
    const walk = node => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      if (node.type === 'section') sections.push(node)
      if (node.children) walk(node.children)
    }
    walk(tree)

    // One section per provider, and each carries that provider's own controls.
    // Two switches: the route's own on/off, and whether it uses the shared
    // default endpoint.
    assert.equal(sections.length, 2, `expected 2 cards, got ${sections.length}`)
    for (const id of ['sensenova', 'openai']) {
      const card = sections.find(s => textsOf(s).includes(id))
      assert.ok(card, `no card for ${id}`)
      const controls = findCheckboxes(card)
      assert.equal(controls.length, 2, `${id} must own two switches: enable, and use-default`)
      for (const label of ['为该 provider 启用代理', '使用默认代理', '类型', 'IP / 主机', '端口', '用户名']) {
        assert.ok(textsOf(card).includes(label), `${id} is missing its ${label} field`)
      }
    }
    // The shared endpoint block is a plain div, never a provider card: a
    // `section` here would be counted as a third provider with no name.
    assert.ok(
      !sections.some(section => textsOf(section).includes('默认代理')),
      'the shared default endpoint must not be rendered as a provider card',
    )
  } finally {
    restore()
  }
})

test('a control reflects the edit immediately, before the write settles', async () => {
  // The reported bug: ticking "为该 provider 启用代理" left the box unchecked
  // until the panel was rebuilt, because the value came straight from the
  // settings store. The control must show the new state on the SAME render.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    let tree = render()

    const target = findCheckboxes(tree).find(box => box.props.checked === false)
    assert.ok(target, 'expected an unchecked provider')
    const initial = findCheckboxes(tree).filter(b => b.props.checked === true).length

    // No await: the very next render must already show the tick.
    target.props.onChange({ target: { checked: true } })
    tree = render()
    assert.equal(
      findCheckboxes(tree).filter(b => b.props.checked === true).length,
      initial + 1,
      '勾选后必须立刻反馈，不能等写入完成',
    )

    await settle()
    tree = render()
    assert.equal(
      findCheckboxes(tree).filter(b => b.props.checked === true).length,
      initial + 1,
      '写入完成后状态必须保持',
    )
  } finally {
    restore()
  }
})

test('a refused write drops the optimistic value', async () => {
  // A conflict or validation failure must not leave the UI showing a value the
  // Host never accepted.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    harness.form.mutate = async () => { throw new Error('settings/conflict') }
    const [, render] = renderPage(mod, harness)
    await settle()
    let tree = render()

    const target = findCheckboxes(tree).find(b => b.props.checked === false)
    const before = findCheckboxes(tree).filter(b => b.props.checked === true).length
    target.props.onChange({ target: { checked: true } })
    // The write is debounced; the refusal (and the rollback) only exists after it fires.
    await writeSettle()
    tree = render()
    assert.equal(
      findCheckboxes(tree).filter(b => b.props.checked === true).length,
      before,
      '被拒绝的值必须回滚，不能留在界面上',
    )
  } finally {
    restore()
  }
})

test('a refused write rolls back only the failed field', async () => {
  // The rollback used to delete the provider's WHOLE draft entry, throwing away
  // edits of other fields that the Host never objected to. Only the refused
  // field may revert to the stored value.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    harness.form.mutate = async ops => {
      if (ops.some(op => op.path[op.path.length - 1] === 'port')) throw new Error('settings/conflict')
    }
    const [, render] = renderPage(mod, harness)
    await settle()
    const tree = render()

    // The enabled card (`sensenova`): stored host 10.0.0.1, port 7890. Scoped to
    // the card, because the shared-default block renders the same placeholders.
    const card = cardFor(tree, 'sensenova')
    assert.ok(card, 'expected the sensenova card')
    const hostInput = findInputsByPlaceholder(card, '127.0.0.1').find(n => n.props.disabled !== true)
    const portInput = findInputsByPlaceholder(card, '7890').find(n => n.props.disabled !== true)
    assert.ok(hostInput && portInput, 'expected the enabled card host and port inputs')

    // Edit host (write succeeds) and port (write is refused) in one burst.
    hostInput.props.onChange({ target: { value: '10.9.9.9' } })
    portInput.props.onChange({ target: { value: '1234' } })
    await writeSettle()

    const after = render()
    const cardAfter = cardFor(after, 'sensenova')
    const hostAfter = findInputsByPlaceholder(cardAfter, '127.0.0.1').find(n => n.props.disabled !== true)
    const portAfter = findInputsByPlaceholder(cardAfter, '7890').find(n => n.props.disabled !== true)
    assert.equal(hostAfter.props.value, '10.9.9.9', 'the accepted host edit must survive the rollback')
    assert.equal(portAfter.props.value, '7890', 'the refused port edit must revert to the stored value')
  } finally {
    restore()
  }
})

test('a write goes through the settings form, fenced by the read revision', async () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations, writes } = mountPlugin(mod)
    registrations[0].Component()
    await settle()
    // Rows sort by id, so `openai` precedes `sensenova`; the first toggle is openai's.
    const toggle = findCheckbox(registrations[0].Component())
    assert.ok(toggle, 'expected a checkbox')
    toggle.props.onChange({ target: { checked: true } })
    await writeSettle()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].revision, 7, 'writes are fenced by the revision that was read')
    assert.equal(writes[0].ops[0].op, 'set')
    assert.deepEqual(writes[0].ops[0].path, ['providers', 'openai', 'enabled'])
    assert.equal(writes[0].ops[0].value, true)
  } finally {
    restore()
  }
})

test('a burst of edits to one field collapses into a single write', async () => {
  // Typing fires `bind` per keystroke, and every write makes the Host rebuild
  // its whole proxy table. The debounce must carry only the LAST value through,
  // so ten characters cost one dispatcher generation instead of ten.
  const { mod, restore } = loadBundle()
  try {
    const { registrations, writes } = mountPlugin(mod)
    await settle()
    const tree = registrations[0].Component()
    // The shared-default block renders a host input with the same placeholder,
    // so scope the search to the card; only `sensenova` is enabled.
    const hostInput = findInputsByPlaceholder(cardFor(tree, 'sensenova'), '127.0.0.1')
      .find(node => node.props.disabled !== true)
    assert.ok(hostInput, 'expected an enabled host input')
    hostInput.props.onChange({ target: { value: '10.0.0.' } })
    hostInput.props.onChange({ target: { value: '10.0.0.2' } })
    hostInput.props.onChange({ target: { value: '10.0.0.254' } })
    await writeSettle()
    assert.equal(writes.length, 1, `expected 1 coalesced write, got ${writes.length}`)
    assert.deepEqual(writes[0].ops[0].path, ['providers', 'sensenova', 'host'])
    assert.equal(writes[0].ops[0].value, '10.0.0.254', 'the write must carry the LAST value of the burst')
  } finally {
    restore()
  }
})

test('the page still renders when no providers are known', async () => {
  const { mod, restore } = loadBundle(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ providers: [] }),
  }))
  try {
    // No configured provider and none published: the page still renders.
    const { registrations } = mountPlugin(mod, { value: { providers: {} } })
    registrations[0].Component()
    await settle()
    const out = registrations[0].Component()
    assert.notEqual(out, null)
    assert.ok(textsOf(out).includes('没有检测到任何 provider。'))
  } finally {
    restore()
  }
})

test('a missing settings form degrades to a page, not a crash', () => {
  const { mod, restore } = loadBundle()
  try {
    const { ctx, registrations, declare } = makeCtx()
    declare(['slots'])
    mod.apply(ctx)
    assert.notEqual(registrations[0].Component(), null)
  } finally {
    restore()
  }
})

test('React comes from the module table, never from ctx', () => {
  assert.ok(!/\bctx\.react\b/.test(clientSource), 'must not read React from ctx')
  assert.ok(bundle.includes('require("react")'), 'must resolve React through the module table')
})

test('the CSS class map is imported as a binding, not a side effect', () => {
  assert.match(clientSource, /import styles from ['"]\.\/client\.css['"]/)
})

test('the layout is carried by inline styles, not only by the stylesheet', async () => {
  // The stylesheet pipeline failed twice in ways invisible from the source: the
  // class map never bound, and a shared class prefix merged two rules. Both left
  // the page readable but collapsed into one unstyled block. Structure now
  // lives in `style` props, so it must survive a stylesheet failure.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const tree = render()

    const sections = []
    const styled = []
    const walk = node => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      if (node.type === 'section') sections.push(node)
      if (node.props?.style && Object.keys(node.props.style).length > 0) styled.push(node)
      if (node.children) walk(node.children)
    }
    walk(tree)

    assert.ok(sections.length > 0, 'no provider card rendered')
    const card = sections[0]
    for (const prop of ['display', 'flexDirection', 'border', 'borderRadius', 'padding', 'gap']) {
      assert.ok(card.props.style?.[prop] !== undefined, `卡片必须内联设置 ${prop}`)
    }

    // The fields must sit on a grid with a label column, or they stack exactly
    // as the screenshots showed.
    let grids = 0
    const countGrids = node => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(countGrids)
      if (node.props?.style?.gridTemplateColumns) grids++
      if (node.children) countGrids(node.children)
    }
    countGrids(tree)
    assert.ok(grids >= 4, `字段应该用栅格排版，实际只有 ${grids} 个`)

    // Pills and inputs must be styled inline too, not left to the stylesheet.
    assert.ok(styled.length >= 8, `只有 ${styled.length} 个元素带内联样式`)
    assert.equal(tree.props?.style?.display, 'flex', '页面根节点必须是纵向布局')
  } finally {
    restore()
  }
})

test('rendered elements actually carry hashed CSS-Modules classes', () => {
  // The reported bug: the page rendered as one unstyled block. The stylesheet
  // was injected, but esbuild's `__toESM(require_css(), 1)` overwrote `default`
  // with the whole module object, so every `styles.x` read was undefined and no
  // element carried a class at all.
  const { mod, restore } = loadBundle()
  try {
    const { registrations } = mountPlugin(mod)
    registrations[0].Component()
    const classes = []
    const walk = node => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      const name = node.props?.className
      if (typeof name === 'string' && name.length > 0) classes.push(name)
      if (node.children) walk(node.children)
    }
    walk(registrations[0].Component())

    assert.ok(classes.length > 0, 'no element carries a className, so the page is unstyled')
    for (const name of classes) {
      assert.match(
        name,
        /^[0-9a-f]{8}_/,
        `"${name}" is not a hashed CSS-Modules class; the class map did not bind`,
      )
    }
    // The card layout depends on these.
    for (const required of ['_root', '_card', '_input']) {
      assert.ok(
        classes.some(name => name.endsWith(required)),
        `no element uses ${required}, so the layout cannot apply`,
      )
    }
  } finally {
    restore()
  }
})

test('the self-check button carries the class its hover rule is written for', () => {
  // The failure this guards is silent in both directions: an element reading
  // `styles.testButton` while the sheet has no such rule renders unstyled (the
  // class map answers `undefined`), and a rule without the element is dead CSS.
  // A hover state cannot be written inline, so this pair is the only way it
  // ships at all.
  const { mod, restore } = loadBundle()
  try {
    const { registrations } = mountPlugin(mod)
    registrations[0].Component()
    const names = []
    const walk = node => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      if (typeof node.props?.className === 'string') names.push(node.props.className)
      if (node.children) walk(node.children)
    }
    walk(registrations[0].Component())

    assert.ok(
      names.some(name => name.endsWith('_testButton')),
      'the self-check button must carry a hashed class',
    )
    assert.match(
      clientCss,
      /\.testButton:hover/,
      'the sheet must carry the hover rule that class is for',
    )
    // The declarations must be IMPORTANT. The button's base border and background
    // are inline, and the cascade sorts a style attribute after every author rule,
    // so a plain declaration here matches, ships, and still loses — which is
    // exactly how the first version of this rule shipped dead.
    const hoverRule = clientCss.match(/\.testButton:hover:not\(:disabled\)\s*\{([^}]*)\}/)?.[1] ?? ''
    assert.match(hoverRule, /border-color:[^;]*!important/, 'the hover border must outrank the inline base')
    assert.match(hoverRule, /background:[^;]*!important/, 'the hover background must outrank the inline base')
    // And the tokens must be visible ones: in the light theme every `bg-layer`
    // token resolves to the SAME colour, so a layer swap renders as nothing.
    assert.match(
      hoverRule,
      /background:[^;]*var\(--dsw-alias-interactive-bg-hover\)/,
      'the hover fill must be the app hover token, not a background layer',
    )
  } finally {
    restore()
  }
})

test('the input state rules win over the inline base they are written against', () => {
  // Same trap as the self-check button: `border`, `background` and `color` are
  // inline on every field, and the cascade sorts the style attribute after every
  // author rule. Without `!important` these rules matched, shipped, and did
  // nothing — hover, focus and the disabled look were all dead until now.
  const ruleFor = re => clientCss.match(re)?.[1] ?? ''
  const hover = ruleFor(/\.input:hover:not\(:disabled\)\s*\{([^}]*)\}/)
  const focus = ruleFor(/\.input:focus\s*\{([^}]*)\}/)
  const disabled = ruleFor(/\.input:disabled\s*\{([^}]*)\}/)

  assert.ok(hover !== '', 'the hover rule must exist')
  assert.match(hover, /border-color:[^;]*!important/, 'the hover border must outrank the inline base')
  assert.ok(
    !/border-color:[^;]*(border-l1|border-l2)\b/.test(hover),
    'l1→l2 is a 4%→10% black step on a 1px line: invisible. Hover needs a stronger token.',
  )
  assert.match(focus, /border-color:[^;]*!important/, 'the focus border must outrank the inline base')
  assert.match(disabled, /background:[^;]*!important/, 'the disabled background must outrank it too')
  assert.match(disabled, /color:[^;]*!important/, 'so must the disabled colour')
})

test('the stylesheet is injected at materialization, not at script load', () => {
  const styles = []
  const previous = { window: globalThis.window, document: globalThis.document }
  globalThis.window = { __ModuleLoader__: { load: o => { globalThis.__reg = o } } }
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, set textContent(v) { styles.push(v) } }),
    head: { appendChild() {} },
  }
  try {
    delete globalThis.__dshPluginStyles
    // eslint-disable-next-line no-new-func
    new Function(bundle)()
    assert.equal(styles.length, 0, 'loading the script must not inject the sheet')
    globalThis.__reg.factory(spec => (spec === 'react' ? React : {}))
    assert.equal(styles.length, 1, 'the sheet is injected when the factory runs')
    assert.match(styles[0], /--dsw-alias-border-l1/, 'the sheet uses shared tokens')
  } finally {
    globalThis.window = previous.window
    globalThis.document = previous.document
    delete globalThis.__reg
  }
})

test('the catalogue is re-polled while the page is open and stops when it goes stale', async () => {
  // The catalogue is a snapshot once fetched: the hit counter would never move
  // and a route the Host starts refusing would stay invisible. The page keeps a
  // poll alive while it renders and cancels it once nothing re-renders it —
  // a closed panel must not leave a fetch running forever.
  const real = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    now: Date.now,
  }
  let tick = () => {}
  let period = 0
  let cleared = false
  let clock = 1_000_000
  globalThis.setInterval = (fn, ms) => { tick = fn; period = ms; return 1 }
  globalThis.clearInterval = () => { cleared = true }
  Date.now = () => clock
  const { mod, requested, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()

    assert.equal(period, 10_000, 'the poll runs at the documented interval')

    const fetchesBefore = requested.length
    await tick()
    await settle()
    assert.ok(
      requested.length > fetchesBefore,
      'a poll tick re-fetches the catalogue and feeds it to the live setter',
    )

    // No further render: the page looks closed. The next tick must cancel the
    // interval instead of fetching again.
    clock += 30_000
    await tick()
    assert.equal(cleared, true, 'a stale page stops the poll')
    const afterStop = requested.length
    await tick()
    assert.equal(requested.length, afterStop, 'a cancelled poll fetches nothing')
    assert.ok(render(), 'the page still renders normally afterwards')
  } finally {
    globalThis.setInterval = real.setInterval
    globalThis.clearInterval = real.clearInterval
    Date.now = real.now
    restore()
  }
})

// ---- shared default endpoint ----

/**
 * Inputs carrying one placeholder that are NOT inside any `<section>` card.
 *
 * The shared-default block renders the same host/port placeholders the cards do,
 * so "the card's input" and "the default block's input" can only be told apart
 * by which of them sits outside a card.
 */
function findInputsOutsideSections(node, placeholder, out = [], inSection = false) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach(n => findInputsOutsideSections(n, placeholder, out, inSection))
    return out
  }
  const nowInSection = inSection || node.type === 'section'
  if (!nowInSection && node.type === 'input' && node.props?.placeholder === placeholder) out.push(node)
  if (node.children) findInputsOutsideSections(node.children, placeholder, out, nowInSection)
  return out
}

test('the shared default endpoint is its own block, not a provider card', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [tree] = renderPage(mod, harness)
    const texts = textsOf(tree)
    assert.ok(texts.includes('默认代理'), 'the shared endpoint must be rendered under its own title')
    assert.ok(
      texts.includes('使用默认代理'),
      'every card must offer the opt-in switch for the shared endpoint',
    )
    // It is the only place the address can be typed, so it must exist even when
    // no card has opted in yet.
    assert.ok(
      findInputsOutsideSections(tree, '127.0.0.1').length > 0,
      'the default block must offer a host input',
    )
  } finally {
    restore()
  }
})

test('a card that uses the default names the address it will actually use', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
        providers: {
          sensenova: {
            enabled: true,
            useDefault: true,
            protocol: 'http',
            host: '',
            port: 0,
            username: '',
            password: '',
          },
        },
      },
    })
    const [tree] = renderPage(mod, harness)
    const card = cardFor(tree, 'sensenova')
    assert.ok(card, 'expected the sensenova card')
    assert.ok(
      textsOf(card).includes('使用默认代理：http://127.0.0.1:7890'),
      'an inheriting card must name the endpoint it will use',
    )
    assert.ok(
      !textsOf(card).includes('IP / 主机'),
      'an inheriting card must not render its own endpoint inputs — they do not apply',
    )
  } finally {
    restore()
  }
})

test('a card using an unconfigured default explains the refusal', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: {
            enabled: true,
            useDefault: true,
            protocol: 'http',
            host: '',
            port: 0,
            username: '',
            password: '',
          },
        },
      },
    })
    const [tree] = renderPage(mod, harness)
    const card = cardFor(tree, 'sensenova')
    assert.ok(
      textsOf(card).some(text => text.includes('顶层默认代理未配置')),
      'the card must say why it is not proxied instead of showing empty inputs',
    )
  } finally {
    restore()
  }
})

test('the shared default endpoint is written to its own settings path', async () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations, writes } = mountPlugin(mod)
    registrations[0].Component()
    await settle()
    const tree = registrations[0].Component()
    const host = findInputsOutsideSections(tree, '127.0.0.1')[0]
    assert.ok(host, 'expected the default block host input')
    host.props.onChange({ target: { value: '10.0.0.9' } })
    await writeSettle()
    assert.equal(writes.length, 1)
    assert.deepEqual(writes[0].ops[0].path, ['defaultProxy', 'host'])
    assert.equal(writes[0].ops[0].value, '10.0.0.9')
  } finally {
    restore()
  }
})

test('the use-default switch persists to the route it belongs to', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'sensenova')
    const [, useDefaultBox] = findCheckboxes(card)
    assert.ok(useDefaultBox, 'expected the use-default switch on the card')
    useDefaultBox.props.onChange({ target: { checked: true } })
    await writeSettle()
    assert.deepEqual(
      harness.writes[0].ops[0].path,
      ['providers', 'sensenova', 'useDefault'],
      'the switch writes to the route, never to the shared block',
    )
    assert.equal(harness.writes[0].ops[0].value, true)
  } finally {
    restore()
  }
})

// ---- testing a route before it is switched on ----

test('a configured but disabled provider can still be tested', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: {
            enabled: false,
            protocol: 'http',
            host: '127.0.0.1',
            port: 7890,
            username: '',
            password: '',
          },
        },
      },
    })
    const [tree] = renderPage(mod, harness)
    const card = cardFor(tree, 'sensenova')
    assert.ok(findButton(card), 'a disabled route with a complete endpoint must offer the check')
    assert.ok(
      textsOf(card).some(text => text.includes('未启用，仅测试')),
      'a check on a route that is off must say it is a trial run',
    )
  } finally {
    restore()
  }
})

test('a disabled provider with no endpoint offers no check', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: {
            enabled: false,
            protocol: 'http',
            host: '',
            port: 0,
            username: '',
            password: '',
          },
        },
      },
    })
    const [tree] = renderPage(mod, harness)
    const card = cardFor(tree, 'sensenova')
    assert.equal(
      findButton(card),
      undefined,
      'nothing to check: the Host would only answer "not enabled"',
    )
  } finally {
    restore()
  }
})

test('the endpoint fields stay editable while the route is off', async () => {
  // Otherwise a proxy setting could only be typed in while traffic was ALREADY
  // flowing through it, which defeats checking it before switching it on.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: {
            enabled: false,
            protocol: 'http',
            host: '',
            port: 0,
            username: '',
            password: '',
          },
        },
      },
    })
    const [tree] = renderPage(mod, harness)
    const card = cardFor(tree, 'sensenova')
    const host = findInputsByPlaceholder(card, '127.0.0.1')[0]
    assert.ok(host, 'expected a host input on the disabled card')
    assert.notEqual(host.props.disabled, true, 'a disabled route must still be configurable')
  } finally {
    restore()
  }
})

// ---- pasting a full proxy URL ----

/** Fire a paste of `text` at one input, reporting whether it was intercepted. */
function paste(input, text) {
  let prevented = false
  input.props.onPaste({
    clipboardData: { getData: () => text },
    preventDefault: () => { prevented = true },
  })
  return prevented
}

test('pasting a full proxy URL fills the card fields in ONE write', async () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations, writes } = mountPlugin(mod)
    await settle()
    const card = cardFor(registrations[0].Component(), 'sensenova')
    const host = findInputsByPlaceholder(card, '127.0.0.1')[0]
    assert.ok(host, 'expected the card host input')

    const prevented = paste(host, 'socks5://alice:hunter2@proxy.test:1080')
    await writeSettle()

    assert.equal(prevented, true, 'a recognised URL is applied, not also typed into the field')
    assert.equal(writes.length, 1, 'the whole URL lands as ONE write, not five table rebuilds')
    assert.deepEqual(
      writes[0].ops.map(op => [op.path[1], op.path[2], op.value]),
      [
        ['sensenova', 'protocol', 'socks5'],
        ['sensenova', 'host', 'proxy.test'],
        ['sensenova', 'port', 1080],
        ['sensenova', 'username', 'alice'],
        ['sensenova', 'password', 'hunter2'],
      ],
    )
  } finally {
    restore()
  }
})

test('pasted credentials are percent-decoded and an IPv6 host is unbracketed', async () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations, writes } = mountPlugin(mod)
    await settle()
    const card = cardFor(registrations[0].Component(), 'sensenova')
    paste(findInputsByPlaceholder(card, '127.0.0.1')[0], 'socks5://u%3Ap:p%40ss@[::1]:1080')
    await writeSettle()
    const byField = Object.fromEntries(writes[0].ops.map(op => [op.path[2], op.value]))
    assert.equal(byField.host, '::1', 'WHATWG brackets an IPv6 literal; the field wants it bare')
    assert.equal(byField.username, 'u:p', 'the parser does not decode userinfo, so this does')
    assert.equal(byField.password, 'p@ss')
    assert.equal(byField.protocol, 'socks5')
    assert.equal(byField.port, 1080)
  } finally {
    restore()
  }
})

test('a pasted socks:// alias lands on socks5', async () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations, writes } = mountPlugin(mod)
    await settle()
    const card = cardFor(registrations[0].Component(), 'sensenova')
    paste(findInputsByPlaceholder(card, '127.0.0.1')[0], 'socks://proxy.test:1080')
    await writeSettle()
    const byField = Object.fromEntries(writes[0].ops.map(op => [op.path[2], op.value]))
    assert.equal(byField.protocol, 'socks5', 'the alias the plugin itself rejects is normalised, not stored')
    assert.equal(byField.host, 'proxy.test')
  } finally {
    restore()
  }
})

test('a pasted value that is not a proxy URL is left alone', async () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations, writes } = mountPlugin(mod)
    await settle()
    const card = cardFor(registrations[0].Component(), 'sensenova')
    const prevented = paste(findInputsByPlaceholder(card, '127.0.0.1')[0], '10.0.0.7')
    await writeSettle()
    assert.equal(prevented, false, 'a bare host must still land in the field normally')
    assert.equal(writes.length, 0)
  } finally {
    restore()
  }
})

test('the shared default block accepts a pasted proxy URL too', async () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations, writes } = mountPlugin(mod)
    registrations[0].Component()
    await settle()
    const host = findInputsOutsideSections(registrations[0].Component(), '127.0.0.1')[0]
    assert.ok(host, 'expected the default block host input')
    paste(host, 'http://bob:pw@10.0.0.1:3128')
    await writeSettle()
    assert.deepEqual(
      writes[0].ops.map(op => [op.path[0], op.path[1], op.value]),
      [
        ['defaultProxy', 'protocol', 'http'],
        ['defaultProxy', 'host', '10.0.0.1'],
        ['defaultProxy', 'port', 3128],
        ['defaultProxy', 'username', 'bob'],
        ['defaultProxy', 'password', 'pw'],
      ],
    )
  } finally {
    restore()
  }
})

// ---- filtering the provider list ----

test('the list can be filtered without touching any saved setting', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const { writes } = harness
    const [, render] = renderPage(mod, harness)
    await settle()
    const input = findInputsByPlaceholder(render(), '按名称或 id 过滤…')[0]
    assert.ok(input, 'expected the filter input above the cards')

    input.props.onChange({ target: { value: 'sense' } })
    assert.ok(cardFor(render(), 'sensenova'), 'a matching provider stays')
    assert.equal(cardFor(render(), 'openai'), undefined, 'a non-matching provider is hidden')

    input.props.onChange({ target: { value: '' } })
    assert.ok(cardFor(render(), 'openai'), 'clearing the filter brings every card back')

    await writeSettle()
    assert.equal(writes.length, 0, 'the filter is a view concern, it must never write a setting')
  } finally {
    restore()
  }
})

test('a filter that matches nothing says so, instead of an empty page', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    findInputsByPlaceholder(render(), '按名称或 id 过滤…')[0].props.onChange({ target: { value: 'zzz' } })
    const texts = textsOf(render())
    assert.ok(texts.includes('没有匹配的 provider。'))
    assert.ok(
      !texts.includes('没有检测到任何 provider。'),
      'a filter miss must not read as though the deployment offered nothing',
    )
  } finally {
    restore()
  }
})

// ---- last-use / last-failure on the card ----

test('the card names the last failure instead of only flagging it', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? {}
        : {
            providers: [{ id: 'sensenova', name: 'SenseNova', live: true }],
            hits: { sensenova: 2 },
            lastUse: { sensenova: { at: Date.now() - 5 * 60_000, ok: false, code: 'ECONNREFUSED' } },
          },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())
    assert.ok(
      texts.includes('最近失败 ECONNREFUSED'),
      'the failure is named with its machine code, so it points somewhere',
    )
    assert.ok(
      JSON.stringify(render()).includes('dsw-alias-state-error-primary'),
      'a failure is an answer, so it takes the error colour',
    )
  } finally {
    restore()
  }
})

test('the card shows when a healthy route last ran', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? {}
        : {
            providers: [{ id: 'sensenova', name: 'SenseNova', live: true }],
            lastUse: { sensenova: { at: Date.now() - 3 * 60_000, ok: true, code: '200' } },
          },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    assert.ok(
      textsOf(render()).includes('最近成功 3 分钟前'),
      'a healthy route says how long ago it last worked',
    )
    assert.ok(
      !JSON.stringify(render()).includes('最近失败'),
      'a healthy route must not be labelled a failure',
    )
  } finally {
    restore()
  }
})

test('a request that has only STARTED is shown as a call at its start time', async () => {
  // The Host keeps `startedAt` apart from the outcome fields. A still-in-flight
  // request must not be shown as a success or failure, and the time shown is its
  // START — never the finish time of some other call.
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? {}
        : {
            providers: [{ id: 'sensenova', name: 'SenseNova', live: true }],
            lastUse: { sensenova: { startedAt: Date.now() - 60_000 } },
          },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())
    assert.ok(
      texts.includes('最近调用 1 分钟前'),
      'a started-but-unsettled call is shown by its start time',
    )
    assert.ok(
      !JSON.stringify(render()).includes('最近成功'),
      'an outcome must not be claimed before the request has settled',
    )
  } finally {
    restore()
  }
})

test('the time a healthy route shows is its FINISH time, not a newer start', async () => {
  // Two concurrent calls: `startedAt` is the newer (second) start, `at` is the
  // (older) first call's finish. The card must read the finish time, so the
  // timestamp always belongs to the call whose outcome is shown.
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? {}
        : {
            providers: [{ id: 'sensenova', name: 'SenseNova', live: true }],
            lastUse: {
              sensenova: { startedAt: Date.now() - 60_000, at: Date.now() - 5 * 60_000, ok: true, code: '200' },
            },
          },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    assert.ok(
      textsOf(render()).includes('最近成功 5 分钟前'),
      'the success line uses `at` (finish), not the newer `startedAt`',
    )
  } finally {
    restore()
  }
})

test('a malformed last-use entry is dropped rather than rendered', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? {}
        : {
            providers: [{ id: 'sensenova', name: 'SenseNova', live: true }],
            lastUse: { sensenova: { at: 'yesterday', ok: true, code: '200' } },
          },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())
    assert.ok(
      !texts.some(text => text.includes('最近成功') || text.includes('最近调用')),
      'a timestamp that is not a finite number must not reach the page',
    )
  } finally {
    restore()
  }
})

// ---- promote to default / bulk apply ----

test('a card promotes its own endpoint to the shared default', async () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations, writes } = mountPlugin(mod)
    await settle()
    const card = cardFor(registrations[0].Component(), 'sensenova')
    const promote = findButtons(card).find(button => textsOf(button).includes('设为默认代理'))
    assert.ok(promote, 'a card carrying its own endpoint offers the promote button')
    promote.props.onClick()
    await writeSettle()
    assert.deepEqual(
      writes[0].ops.map(op => [op.path[0], op.path[1], op.value]),
      [
        ['defaultProxy', 'protocol', 'http'],
        ['defaultProxy', 'host', '10.0.0.1'],
        ['defaultProxy', 'port', 7890],
        ['defaultProxy', 'username', ''],
        ['defaultProxy', 'password', ''],
      ],
    )
  } finally {
    restore()
  }
})

test('an inheriting card has nothing to promote', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
        providers: {
          sensenova: {
            enabled: true,
            useDefault: true,
            protocol: 'http',
            host: '',
            port: 0,
            username: '',
            password: '',
          },
        },
      },
    })
    const [tree] = renderPage(mod, harness)
    assert.equal(
      findButtons(cardFor(tree, 'sensenova')).find(button => textsOf(button).includes('设为默认代理')),
      undefined,
      'a card already using the default would only be copying it onto itself',
    )
  } finally {
    restore()
  }
})

test('the bulk button points every card at the default, in ONE write', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' },
        providers: {
          sensenova: {
            enabled: true,
            protocol: 'http',
            host: '10.0.0.1',
            port: 7890,
            username: '',
            password: '',
          },
        },
      },
    })
    const { writes } = harness
    // `renderPage` (not a bare Component() call) keeps ONE hook store across
    // renders, so the catalogue that arrives asynchronously actually sticks.
    const [, render] = renderPage(mod, harness)
    await settle()
    const applyAll = findButtons(render()).find(button =>
      textsOf(button).includes('所有 provider 使用默认代理'),
    )
    assert.ok(applyAll, 'expected the bulk button in the shared-default block')
    assert.notEqual(applyAll.props.disabled, true, 'the default is usable, so the button is enabled')

    applyAll.props.onClick()
    await writeSettle()
    assert.equal(writes.length, 1, 'one write, not one table rebuild per card')
    // Rows sort by name, so OpenAI precedes SenseNova.
    assert.deepEqual(
      writes[0].ops.map(op => [op.path[1], op.path[2], op.value]),
      [
        ['openai', 'useDefault', true],
        ['sensenova', 'useDefault', true],
      ],
    )
  } finally {
    restore()
  }
})

test('the bulk button is disabled while the default is unusable', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const applyAll = findButtons(render()).find(button =>
      textsOf(button).includes('所有 provider 使用默认代理'),
    )
    assert.ok(applyAll)
    assert.equal(
      applyAll.props.disabled,
      true,
      'pointing every card at an empty endpoint would just refuse them all',
    )
  } finally {
    restore()
  }
})

test('a default host carrying a scheme does not read as usable', async () => {
  // The browser must apply the SAME predicate the Host does. A host like
  // `https://1.2.3.4` has no scheme/path removed by the paste handler here, and
  // the Host refuses every route that points at it — so the browser must not
  // light the block green nor enable the bulk button.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: { defaultProxy: { protocol: 'http', host: 'https://1.2.3.4', port: 7890 } },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    const applyAll = findButtons(render()).find(button =>
      textsOf(button).includes('所有 provider 使用默认代理'),
    )
    assert.ok(applyAll)
    assert.equal(
      applyAll.props.disabled,
      true,
      'a scheme-carrying host cannot carry a route, so the bulk button must stay off',
    )
  } finally {
    restore()
  }
})

test('an enabled route with no record yet says so; a disabled one stays silent', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    assert.ok(
      textsOf(cardFor(render(), 'sensenova')).includes('尚无代理记录'),
      'a missing record must be distinguishable from a missing feature',
    )
    assert.ok(
      !textsOf(cardFor(render(), 'openai')).includes('尚无代理记录'),
      'a disabled route cannot have a record, so saying so on it would just be noise',
    )
  } finally {
    restore()
  }
})