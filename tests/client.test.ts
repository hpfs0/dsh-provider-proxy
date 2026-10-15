// Guards the silent failures that shipped before: a client half that never
// registers, and one that registers but renders nothing. Both are invisible in
// the UI — no error, no request, no entry.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const clientSource = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
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
    assert.equal(sections.length, 2, `expected 2 cards, got ${sections.length}`)
    for (const id of ['sensenova', 'openai']) {
      const card = sections.find(s => textsOf(s).includes(id))
      assert.ok(card, `no card for ${id}`)
      const controls = findCheckboxes(card)
      assert.equal(controls.length, 1, `${id} must own exactly one switch`)
      for (const label of ['为该 provider 启用代理', '类型', 'IP / 主机', '端口', '用户名']) {
        assert.ok(textsOf(card).includes(label), `${id} is missing its ${label} field`)
      }
    }
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
    await settle()
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
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(writes.length, 1)
    assert.equal(writes[0].revision, 7, 'writes are fenced by the revision that was read')
    assert.equal(writes[0].ops[0].op, 'set')
    assert.deepEqual(writes[0].ops[0].path, ['providers', 'openai', 'enabled'])
    assert.equal(writes[0].ops[0].value, true)
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