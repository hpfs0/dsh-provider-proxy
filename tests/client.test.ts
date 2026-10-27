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

function findPasswordInputs(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) { node.forEach(n => findPasswordInputs(n, out)); return out }
  if (
    node.type === 'input' &&
    (node.props?.type === 'password' || node.props?.type === 'text') &&
    node.props?.autoComplete === 'off'
  ) {
    out.push(node)
  }
  if (node.children) findPasswordInputs(node.children, out)
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

/** The status pill sits at the end of the card header. */
function pillTextOf(card) {
  const header = card?.children?.find?.(child => child?.type === 'header')
  return textsOf(header?.children?.[1]).join('')
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

/** The first input inside a field label whose visible label text matches. */
function findInputsUnderLabel(node, label, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach(n => findInputsUnderLabel(n, label, out))
    return out
  }
  if (node.type === 'label' && textsOf(node.children?.[0]).includes(label)) {
    const input = findFirstInput(node)
    if (input !== undefined) out.push(input)
  }
  if (node.children) findInputsUnderLabel(node.children, label, out)
  return out
}

function findFirstInput(node) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findFirstInput(n)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node.type === 'input') return node
  return node.children ? findFirstInput(node.children) : undefined
}

/** The field label whose subtree contains the exact input object. */
function findFieldForInput(node, target) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findFieldForInput(n, target)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node.type === 'label' && containsNode(node, target)) return node
  return node.children ? findFieldForInput(node.children, target) : undefined
}

function containsNode(node, target) {
  if (node === target) return true
  if (node === null || typeof node !== 'object') return false
  if (Array.isArray(node)) return node.some(n => containsNode(n, target))
  return node.children ? containsNode(node.children, target) : false
}

function findFirstNodeOfType(node, type) {
  if (node === null || typeof node !== 'object') return undefined
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findFirstNodeOfType(n, type)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (node.type === type) return node
  return node.children ? findFirstNodeOfType(node.children, type) : undefined
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
    assert.ok(
      textsOf(out).includes('正在读取 provider 列表…'),
      'the first render is the loading state, not a false empty result',
    )
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

test('N6: a password can be revealed without changing its value', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: {
            enabled: true,
            protocol: 'socks5',
            host: '127.0.0.1',
            port: 1080,
            username: 'alice',
            password: 'hunter2-secret',
          },
        },
      },
    })
    const { writes } = harness
    const [, render] = renderPage(mod, harness)
    await settle()

    let card = cardFor(render(), 'sensenova')
    let input = findPasswordInputs(card).find(node => node.props.value === 'hunter2-secret')
    assert.ok(input, 'the card password input must be present')
    assert.equal(input.props.type, 'password', 'passwords start hidden')
    const reveal = findButtons(card).find(button => button.props['aria-label'] === '显示')
    assert.ok(reveal, 'the card must offer a reveal control')
    reveal.props.onClick()

    card = cardFor(render(), 'sensenova')
    input = findPasswordInputs(card).find(node => node.props.value === 'hunter2-secret')
    assert.equal(input?.props.type, 'text', 'revealing changes only the input type')
    assert.equal(input?.props.value, 'hunter2-secret', 'the password value is not rewritten')
    assert.equal(writes.length, 0, 'revealing is view state, never a settings write')
  } finally {
    restore()
  }
})

test('N6: the default password and card passwords toggle independently', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        defaultProxy: {
          protocol: 'http',
          host: '127.0.0.1',
          port: 7890,
          username: 'alice',
          password: 'default-secret',
        },
        providers: {
          sensenova: {
            enabled: true,
            protocol: 'http',
            host: '10.0.0.1',
            port: 7890,
            username: 'bob',
            password: 'card-secret',
          },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()

    const tree = render()
    const defaultInput = findPasswordInputs(tree).find(node => node.props.value === 'default-secret')
    const cardInput = findPasswordInputs(cardFor(tree, 'sensenova')).find(
      node => node.props.value === 'card-secret',
    )
    assert.equal(defaultInput?.props.type, 'password')
    assert.equal(cardInput?.props.type, 'password')

    const defaultReveal = findButtons(tree).find(button => button.props['aria-label'] === '显示')
    assert.ok(defaultReveal)
    defaultReveal.props.onClick()

    const next = render()
    assert.equal(
      findPasswordInputs(next).find(node => node.props.value === 'default-secret')?.props.type,
      'text',
      'the default password is revealed',
    )
    assert.equal(
      findPasswordInputs(cardFor(next, 'sensenova')).find(
        node => node.props.value === 'card-secret',
      )?.props.type,
      'password',
      'revealing the default must not reveal a card password',
    )
  } finally {
    restore()
  }
})

test('N6: a provider named default cannot share the default password visibility', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        defaultProxy: {
          protocol: 'http',
          host: '127.0.0.1',
          port: 7890,
          username: 'alice',
          password: 'default-secret',
        },
        providers: {
          default: {
            enabled: true,
            protocol: 'http',
            host: '10.0.0.1',
            port: 7890,
            username: 'bob',
            password: 'provider-default-secret',
          },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()

    const tree = render()
    const defaultReveal = findButtons(tree).find(button => button.props['aria-label'] === '显示')
    assert.ok(defaultReveal)
    defaultReveal.props.onClick()

    const next = render()
    assert.equal(
      findPasswordInputs(next).find(node => node.props.value === 'default-secret')?.props.type,
      'text',
      'the shared default password is revealed',
    )
    assert.equal(
      findPasswordInputs(cardFor(next, 'default')).find(
        node => node.props.value === 'provider-default-secret',
      )?.props.type,
      'password',
      'a provider literally named default must keep its own hidden state',
    )
  } finally {
    restore()
  }
})

test('N6: username and password inputs use the React autoComplete spelling', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [tree] = renderPage(mod, harness)
    const passwordInputs = findPasswordInputs(tree)
    assert.equal(passwordInputs.length >= 2, true, 'the default and card passwords are both present')
    assert.ok(
      passwordInputs.every(input => input.props.autocomplete === undefined),
      'the lowercase DOM spelling is not a React prop',
    )

    const defaultUsername = findInputsUnderLabel(tree, '用户名')[0]
    const cardUsername = findInputsUnderLabel(cardFor(tree, 'sensenova'), '用户名')[0]
    assert.ok(defaultUsername, 'the default username input must be present')
    assert.ok(cardUsername, 'the card username input must be present')
    for (const input of [defaultUsername, cardUsername]) {
      assert.equal(input.props.autoComplete, 'off')
      assert.equal(input.props.autocomplete, undefined)
    }
  } finally {
    restore()
  }
})

test('N6: the password reveal control is an accessible icon inside the input', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [tree] = renderPage(mod, harness)
    const passwordInput = findPasswordInputs(tree).find(input => input.props.value === '')
    assert.ok(passwordInput, 'the default password input must be present')

    const field = findFieldForInput(tree, passwordInput)
    assert.ok(field, 'the password input must belong to a field label')
    const reveal = findButtons(field).find(button => button.props['aria-label'] === '显示')
    assert.ok(reveal, 'the reveal control must be inside the password field')
    assert.equal(reveal.props.title, '显示')
    assert.equal(reveal.props['aria-pressed'], false)
    assert.equal(reveal.props.type, 'button')

    const icon = findFirstNodeOfType(reveal, 'svg')
    assert.ok(icon, 'the control must render an icon, not visible text')
    assert.equal(icon.props['aria-hidden'], 'true')
    assert.equal(textsOf(reveal).length, 0, 'the button itself has no visible text')
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
    assert.ok(texts.includes('连接诊断 (2)'), 'the collapsed panel must announce every diagnostic item')
  } finally {
    restore()
  }
})

test('an enabled route with an incomplete endpoint is rejected on its own card', async () => {
  // The Host skips a refused route, so its requests go direct. Leaving the card
  // green and "proxied" is the one lie this page must never tell.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: {
            enabled: true,
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
    const texts = textsOf(card)
    assert.ok(
      texts.includes('未填写代理地址'),
      'the refusal reason must be inside the card, not only in the collapsed panel',
    )
    assert.ok(texts.includes('配置被拒'), 'the pill must not claim a refused route is proxied')
    assert.ok(!texts.includes('走代理'), 'a refused route must not read as proxied')
    assert.ok(
      JSON.stringify(card).includes('dsw-alias-state-error-primary'),
      'a refused route takes the error colour',
    )
  } finally {
    restore()
  }
})

test('a recorded Host refusal wins over a locally valid endpoint', async () => {
  // The local predicate only covers endpoint formatting. A dispatcher that
  // cannot be constructed is known to the Host alone, and its reason must win.
  const { mod, restore } = loadBundle(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      providers: [{ id: 'sensenova', name: 'SenseNova', live: true }],
      problems: { sensenova: '代理端口无效（需为 1-65535 的整数）' },
    }),
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'sensenova')
    assert.ok(card, 'expected the sensenova card')
    const texts = textsOf(card)
    assert.ok(texts.includes('代理端口无效（需为 1-65535 的整数）'))
    assert.ok(texts.includes('配置被拒'))
    assert.ok(!texts.includes('走代理'))
  } finally {
    restore()
  }
})

test('an inheriting card with an unusable default shows one refusal, not two', async () => {
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
    assert.ok(card, 'expected the sensenova card')
    const texts = textsOf(card)
    assert.equal(
      texts.filter(text => text.includes('顶层默认代理配置不完整')).length,
      1,
      'the inherit note and the rejection line must not say the same thing twice',
    )
    assert.ok(texts.includes('配置被拒'))
    assert.ok(!texts.includes('使用默认代理：'), 'the origin note must yield to the refusal')
  } finally {
    restore()
  }
})

test('a disabled route with an incomplete own endpoint is not marked rejected', async () => {
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
    assert.ok(card, 'expected the sensenova card')
    const texts = textsOf(card)
    assert.ok(!texts.includes('未填写代理地址'), 'an unused route has not asked for anything yet')
    assert.ok(!texts.includes('配置被拒'))
  } finally {
    restore()
  }
})

test('a configured route the Host does not list keeps its own switch state', async () => {
  // The Host catalogue is not the route switch. A saved route can outlive the
  // directory entry; the pill must follow the switch, not the catalogue.
  const { mod, restore } = loadBundle(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ providers: [] }),
  }))
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
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'sensenova')
    assert.ok(card, 'a saved route must stay visible even when the provider is gone')
    assert.equal(pillTextOf(card), '直连', 'the proxy switch is off, so the route is direct')
    assert.ok(!textsOf(card).includes('provider 已下线'))
  } finally {
    restore()
  }
})

test('a saved route follows its switch even when the Host does not list the provider', async () => {
  // Enabling a proxy is a route decision. The Host directory's live flag is
  // orthogonal and must not turn the same switch into "offline" or "proxied".
  const { mod, restore } = loadBundle(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      providers: [{ id: 'sensenova', name: 'SenseNova', live: false }],
    }),
  }))
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: {
            enabled: true,
            protocol: 'http',
            host: '127.0.0.1',
            port: 7890,
            username: '',
            password: '',
          },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'sensenova')
    assert.ok(card, 'a saved route must stay visible even when the provider is gone')
    const texts = textsOf(card)
    assert.ok(texts.includes('SenseNova'), 'the published display name must be preserved')
    assert.equal(pillTextOf(card), '走代理', 'the switch is on and the endpoint is complete')
    assert.ok(!texts.includes('已启用'), 'there is no separate availability state in the pill')
    assert.ok(!texts.includes('provider 已下线'), 'the catalogue must not drive the switch state')
  } finally {
    restore()
  }
})

test('the shared default reports configured state, not proxying state', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [tree] = renderPage(mod, harness)
    const texts = textsOf(tree)
    assert.ok(
      texts.includes('未配置'),
      'an empty default is "not configured", not "direct"',
    )
    assert.ok(
      !texts.includes('未填写代理地址'),
      'the optional default block being empty is not a typed input error',
    )
  } finally {
    restore()
  }
})

test('the default pill reports completeness, not proxy reachability', async () => {
  // Port 1 is syntactically complete but very unlikely to be listening. The pill
  // must still say "complete": only a Test run or a last-use record can speak
  // about reachability, and editing a port must not turn this into a health claim.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 1, username: '', password: '' },
      },
    })
    const [tree] = renderPage(mod, harness)
    const texts = textsOf(tree)
    assert.ok(texts.includes('配置完整'))
    assert.ok(
      texts.some(text => text.includes('可达') && text.includes('测试')),
      'the default block must point reachability at the Test button',
    )
  } finally {
    restore()
  }
})

test('the lead describes loopback/private routing as the default, not an absolute', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [tree] = renderPage(mod, harness)
    const texts = textsOf(tree)
    assert.ok(
      texts.some(text => text.includes('默认直连') && text.includes('localDirect')),
      'the lead must name the escape hatch instead of claiming "always direct"',
    )
    assert.ok(!texts.some(text => text.includes('始终直连')))
  } finally {
    restore()
  }
})

// ---- N1: advanced global settings ----

/** The `<details>` block whose summary names the global section. */
function globalBlockOf(tree) {
  let found
  const walk = node => {
    if (found !== undefined || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'details' && textsOf(node).includes('全局设置（高级）')) found = node
    if (node.children) walk(node.children)
  }
  walk(tree)
  return found
}

/** An input inside the global block by its current value. */
function globalInput(tree, value) {
  const inputs = []
  const walk = node => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'input' && node.props?.value === value) inputs.push(node)
    if (node.children) walk(node.children)
  }
  walk(globalBlockOf(tree))
  return inputs[0]
}

test('N1 spike: settings snapshot exposes schema defaults and accepts top-level set paths', async () => {
  // Verified against the shipped settings implementation: `getSnapshot().value`
  // is the schema-resolved section, and SettingsScopeController.set(field)
  // writes {op:'set', path:[field]}. These are the two assumptions the global
  // block depends on.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {},
        testUrl: 'https://api.ipify.org?format=json',
        localDirect: true,
      },
    })
    const [tree] = renderPage(mod, harness)
    const block = globalBlockOf(tree)
    assert.ok(block, 'the global settings block must render')
    assert.ok(globalInput(tree, 'https://api.ipify.org?format=json'), 'the schema default is shown')
    const localDirect = findCheckboxes(block).find(box => box.props.checked === true)
    assert.ok(localDirect, 'localDirect defaults to checked')

    localDirect.props.onChange({ target: { checked: false } })
    await writeSettle()
    assert.deepEqual(harness.writes[0].ops, [
      { op: 'set', path: ['localDirect'], value: false },
    ])
  } finally {
    restore()
  }
})

test('the global settings block is a details element, not another provider card', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: { providers: { sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 } } },
    })
    const [tree] = renderPage(mod, harness)
    const block = globalBlockOf(tree)
    assert.ok(block, 'the global block must be present')
    assert.equal(block.type, 'details')
    assert.ok(
      !block.children.some(child => child?.type === 'section'),
      'the global block must not add a provider <section>',
    )
  } finally {
    restore()
  }
})

test('both global fields write their top-level paths', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const tree = render()

    globalInput(tree, 'https://api.ipify.org?format=json').props.onChange({
      target: { value: 'https://echo.example/ip https://backup.example/ip' },
    })
    await writeSettle()
    findCheckboxes(globalBlockOf(render())).find(box => box.props.checked === true)
      .props.onChange({ target: { checked: false } })
    await writeSettle()

    assert.deepEqual(
      harness.writes.map(write => write.ops[0]),
      [
        {
          op: 'set',
          path: ['testUrl'],
          value: 'https://echo.example/ip https://backup.example/ip',
        },
        { op: 'set', path: ['localDirect'], value: false },
      ],
    )
  } finally {
    restore()
  }
})

test('restore default writes the explicit default test URL', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: { providers: {}, testUrl: 'https://custom.example/ip' },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    const restoreButton = findButtons(globalBlockOf(render())).find(button =>
      textsOf(button).includes('恢复默认'),
    )
    assert.ok(restoreButton, 'the global block offers a restore-default button')
    restoreButton.props.onClick()
    await writeSettle()
    assert.deepEqual(harness.writes[0].ops, [
      { op: 'set', path: ['testUrl'], value: 'https://api.ipify.org?format=json' },
    ])
  } finally {
    restore()
  }
})

test('testUrl validation warns but still writes', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const invalid = globalInput(globalBlockOf(render()), 'https://api.ipify.org?format=json')
    invalid.props.onChange({ target: { value: 'not-a-url' } })
    let texts = textsOf(render())
    assert.ok(
      texts.some(text => text.includes('部分候选不是绝对的 http(s) URL')),
      'an invalid candidate is called out',
    )
    await writeSettle()
    assert.equal(harness.writes.length, 1, 'the warning must not block the write')
    assert.equal(harness.writes[0].ops[0].value, 'not-a-url')

    globalInput(globalBlockOf(render()), 'not-a-url').props.onChange({
      target: { value: 'https://a.example https://b.example https://c.example https://d.example https://e.example https://f.example' },
    })
    texts = textsOf(render())
    assert.ok(
      texts.some(text => text.includes('候选超过 5 个')),
      'the 5-candidate cap is explained',
    )
  } finally {
    restore()
  }
})

test('editing any global field clears every provider result', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: true, ms: 120, status: 200 }
        : {
            providers: [
              { id: 'sensenova', name: 'SenseNova', live: true },
              { id: 'openai', name: 'OpenAI', live: true },
            ],
          },
  }))
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
          openai: { enabled: true, protocol: 'http', host: '10.0.0.2', port: 7890 },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    for (const id of ['sensenova', 'openai']) findTestButton(cardFor(render(), id)).props.onClick()
    await settle()
    assert.ok(JSON.stringify(render()).includes('120 ms'))

    globalInput(globalBlockOf(render()), 'https://api.ipify.org?format=json').props.onChange({
      target: { value: 'https://changed.example/ip' },
    })
    assert.ok(!JSON.stringify(render()).includes('120 ms'), 'all results are invalidated')
    await writeSettle()
  } finally {
    restore()
  }
})

test('a global edit is flushed before testing immediately', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: true, ms: 10, status: 200 }
        : { providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    globalInput(globalBlockOf(render()), 'https://api.ipify.org?format=json').props.onChange({
      target: { value: 'https://changed.example/ip' },
    })
    findTestButton(cardFor(render(), 'sensenova')).props.onClick()
    await settle()
    assert.equal(harness.writes.length, 1, 'the pending global write landed before the test')
    assert.deepEqual(harness.writes[0].ops[0].path, ['testUrl'])
    assert.ok(JSON.stringify(render()).includes('10 ms'), 'the test result arrived')
  } finally {
    restore()
  }
})

test('a refused global write rolls the field back', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    harness.form.mutate = async () => { throw new Error('settings/conflict') }
    const [, render] = renderPage(mod, harness)
    await settle()
    globalInput(globalBlockOf(render()), 'https://api.ipify.org?format=json').props.onChange({
      target: { value: 'https://changed.example/ip' },
    })
    await writeSettle()
    assert.ok(
      globalInput(globalBlockOf(render()), 'https://api.ipify.org?format=json'),
      'the refused edit reverts to the stored value',
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
    const button = findTestButton(cardFor(render(), 'sensenova'))
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

test('N2: a check names its HTTP status, target and cached state', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? {
            ok: true,
            ms: 120,
            status: 401,
            target: 'https://api.example.com/v1',
            cached: true,
          }
        : { providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    findTestButton(cardFor(render(), 'sensenova')).props.onClick()
    await settle()
    const texts = textsOf(cardFor(render(), 'sensenova'))
    assert.ok(
      texts.some(text => text.includes('✓') && text.includes('120 ms')),
      'the latency is shown with the success mark',
    )
    assert.ok(
      texts.includes('HTTP 401'),
      'the status explains where the check reached',
    )
    assert.ok(
      texts.some(text => text.includes('缓存')),
      'a cached answer is labelled',
    )
    assert.ok(
      texts.some(text => text.includes('目标 https://api.example.com/v1')),
      'the sanitized target is visible',
    )
  } finally {
    restore()
  }
})

test('a slow but successful check is not painted like a failure', async () => {
  // The band colour belongs to the latency ALONE. Putting `HTTP 200` inside the
  // same span made a successful 2646 ms check render entirely in the error
  // colour, so it read as a failure.
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: true, ms: 2646, status: 200, target: 'http://www.google.com/' }
        : { providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    findTestButton(cardFor(render(), 'sensenova')).props.onClick()
    await settle()
    const card = cardFor(render(), 'sensenova')
    const texts = textsOf(card)
    assert.ok(
      texts.some(text => text.includes('✓') && text.includes('2646 ms')),
      'the success mark and the latency are both shown',
    )
    assert.ok(
      texts.includes('HTTP 200'),
      'the status is shown, but as its own element',
    )
    assert.ok(
      !texts.some(text => text.includes('✗')),
      'a successful check never shows the failure mark',
    )
    // The status must not inherit the latency's error colour.
    const statusNode = (() => {
      let found
      const walk = node => {
        if (found !== undefined || node === null || typeof node !== 'object') return
        if (Array.isArray(node)) return node.forEach(walk)
        if (node.children) {
          const inner = textsOf(node)
          if (inner.length === 1 && inner[0] === 'HTTP 200') found = node
        }
        if (node.children) walk(node.children)
      }
      walk(card)
      return found
    })()
    assert.ok(statusNode, 'the status is a separate element')
    assert.ok(
      !String(statusNode.props?.style?.color ?? '').includes('state-error'),
      'the status keeps the neutral label colour, not the error colour',
    )
  } finally {
    restore()
  }
})

test('the target line explains where the target came from', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: true, ms: 41, status: 200, target: 'http://www.baidu.com/', targetSource: 'upstream' }
        : { providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    findTestButton(cardFor(render(), 'sensenova')).props.onClick()
    await settle()
    const texts = textsOf(cardFor(render(), 'sensenova'))
    assert.ok(
      texts.some(text => text.includes('http://www.baidu.com/') && text.includes('真实上游')),
      'a provider with a real upstream says so, so the global testUrl is not a mystery',
    )
  } finally {
    restore()
  }
})

test('a provider without a real upstream says it used the global URL', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: true, ms: 41, status: 200, target: 'http://www.google.com/', targetSource: 'testUrl' }
        : { providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    findTestButton(cardFor(render(), 'sensenova')).props.onClick()
    await settle()
    const texts = textsOf(cardFor(render(), 'sensenova'))
    assert.ok(
      texts.some(text => text.includes('http://www.google.com/') && text.includes('全局自检地址')),
      'the card says it used the global self-check URL',
    )
  } finally {
    restore()
  }
})

test('N2: a failed check keeps its target visible', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? {
            ok: false,
            kind: 'target',
            error: '目标不可达（ECONNREFUSED）：connect failed',
            target: 'http://127.0.0.1:65533/upstream',
          }
        : { providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    findTestButton(cardFor(render(), 'sensenova')).props.onClick()
    await settle()
    const tree = JSON.stringify(cardFor(render(), 'sensenova'))
    assert.ok(tree.includes('✗ 目标不可达'), 'the failure reason is still shown')
    assert.ok(
      tree.includes('目标 http://127.0.0.1:65533/upstream'),
      'the target remains visible when the check fails',
    )
  } finally {
    restore()
  }
})

test('an old payload without status or target still renders', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: true, ms: 50 }
        : { providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    findTestButton(cardFor(render(), 'sensenova')).props.onClick()
    await settle()
    const tree = JSON.stringify(cardFor(render(), 'sensenova'))
    assert.ok(tree.includes('✓ 50 ms'), 'legacy payloads omit status without breaking')
    assert.ok(!tree.includes('目标 undefined'), 'a missing target is not rendered')
    // The protocol dropdown carries "HTTP" too, so only the RESULT row may be
    // checked for a status.
    const resultText = textsOf(cardFor(render(), 'sensenova')).filter(text =>
      text.includes('ms'),
    )
    assert.ok(
      resultText.every(text => !text.includes('HTTP')),
      'a payload without a status shows no status',
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
    const button = findTestButton(cardFor(render(), 'sensenova'))
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
    const button = findTestButton(cardFor(render(), 'sensenova'))
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

test('editing a relevant field clears the self-check result', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: true, ms: 120, status: 200 }
        : { providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] },
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    findTestButton(cardFor(render(), 'sensenova')).props.onClick()
    await settle()
    assert.ok(JSON.stringify(cardFor(render(), 'sensenova')).includes('120 ms'))

    const host = findInputsByPlaceholder(cardFor(render(), 'sensenova'), '127.0.0.1')[0]
    assert.ok(host, 'the card must expose its host input')
    host.props.onChange({ target: { value: '10.0.0.2' } })
    const after = cardFor(render(), 'sensenova')
    assert.ok(
      !JSON.stringify(after).includes('120 ms'),
      'a result measured against the old endpoint must not survive the edit',
    )
    assert.ok(!textsOf(after).includes('测试中…'), 'the result is cleared, not left pending')
    await writeSettle()
  } finally {
    restore()
  }
})

test('editing the shared default clears only the cards that inherit it', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: true, ms: 120, status: 200 }
        : {
            providers: [
              { id: 'sensenova', name: 'SenseNova', live: true },
              { id: 'openai', name: 'OpenAI', live: true },
            ],
          },
  }))
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
          openai: {
            enabled: true,
            useDefault: false,
            protocol: 'http',
            host: '10.0.0.1',
            port: 7890,
            username: '',
            password: '',
          },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    for (const id of ['sensenova', 'openai']) {
      findTestButton(cardFor(render(), id)).props.onClick()
    }
    await settle()
    assert.ok(JSON.stringify(cardFor(render(), 'sensenova')).includes('120 ms'))
    assert.ok(JSON.stringify(cardFor(render(), 'openai')).includes('120 ms'))

    const defaultHost = findInputsOutsideSections(render(), '127.0.0.1')[0]
    assert.ok(defaultHost, 'the default block must expose its host input')
    defaultHost.props.onChange({ target: { value: '10.0.0.2' } })
    const tree = render()
    assert.ok(
      !JSON.stringify(cardFor(tree, 'sensenova')).includes('120 ms'),
      'an inheriting card must lose a result tied to the old default',
    )
    assert.ok(
      JSON.stringify(cardFor(tree, 'openai')).includes('120 ms'),
      'a card with its own endpoint is unaffected by the shared default',
    )
    await writeSettle()
  } finally {
    restore()
  }
})

test('editing and testing immediately flushes the write before the self-check', async () => {
  const order = []
  const { mod, restore } = loadBundle(async url => {
    if (String(url).includes('/test')) {
      order.push('test')
      return { ok: true, status: 200, json: async () => ({ ok: true, ms: 120, status: 200 }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] }),
    }
  })
  try {
    const harness = mountPlugin(mod)
    const mutate = harness.form.mutate
    harness.form.mutate = async (ops, revision) => {
      order.push('write')
      return mutate(ops, revision)
    }
    const [, render] = renderPage(mod, harness)
    await settle()

    const host = findInputsByPlaceholder(cardFor(render(), 'sensenova'), '127.0.0.1')[0]
    host.props.onChange({ target: { value: '10.0.0.2' } })
    findTestButton(cardFor(render(), 'sensenova')).props.onClick()
    await settle()

    assert.deepEqual(
      order,
      ['write', 'test'],
      'the Host must see the latest setting before it is asked to test it',
    )
    assert.equal(
      harness.writes[0]?.ops[0]?.value,
      '10.0.0.2',
      'the flushed write must carry the value from the draft',
    )
  } finally {
    restore()
  }
})

test('a self-check that started before an edit is discarded when it settles', async () => {
  let releaseTest
  const { mod, restore } = loadBundle(async url => {
    if (String(url).includes('/test')) {
      await new Promise(resolve => { releaseTest = resolve })
      return { ok: true, status: 200, json: async () => ({ ok: true, ms: 120, status: 200 }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] }),
    }
  })
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    findTestButton(cardFor(render(), 'sensenova')).props.onClick()
    await settle()
    assert.ok(releaseTest, 'the self-check request must be in flight')

    const host = findInputsByPlaceholder(cardFor(render(), 'sensenova'), '127.0.0.1')[0]
    host.props.onChange({ target: { value: '10.0.0.2' } })
    const afterEdit = cardFor(render(), 'sensenova')
    assert.ok(!textsOf(afterEdit).includes('测试中…'), 'the edit clears the pending state')
    assert.notEqual(
      findTestButton(afterEdit).props.disabled,
      true,
      'the Test button is available again after the edit',
    )

    releaseTest()
    await settle()
    assert.ok(
      !JSON.stringify(cardFor(render(), 'sensenova')).includes('120 ms'),
      'a response for the pre-edit configuration must not be rendered',
    )
    await writeSettle()
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

test('the N4 host-rule matrix flags the new dead forms but keeps valid rules', async () => {
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
            onlyHosts: 'example.com:443, *foo, foo*, https://x, x/path, [::1]:443, *., valid.example, *.ok.example, *, [::1]',
            bypassHosts: '',
          },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    const warning = textsOf(render()).find(text => text.includes('永远匹配不上'))
    assert.ok(warning, 'the dead entries are listed together')
    for (const token of ['example.com:443', '*foo', 'foo*', 'https://x', 'x/path', '[::1]:443', '*.']) {
      assert.ok(warning.includes(token), `${token} is reported`)
    }
    assert.ok(!warning.includes('valid.example'), 'a bare host stays unflagged')
    assert.ok(!warning.includes('*.ok.example'), 'a leading *. rule stays unflagged')
    assert.ok(!/(^|、)\*(、|$)/.test(warning), 'the standalone * rule stays unflagged')
    const listed = warning.slice(warning.lastIndexOf('：') + 1).split('、')
    assert.ok(!listed.includes('[::1]'), 'a bracketed IPv6 literal stays unflagged')
    assert.ok(
      warning.includes('不要带端口') && warning.includes('以 *. 开头'),
      'the hint names ports and the allowed wildcard form',
    )
  } finally {
    restore()
  }
})

test('a dead rule is flagged but the edit still saves', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'sensenova')
    const onlyHosts = findInputsByPlaceholder(card, 'api.example.com')[0]
    onlyHosts.props.onChange({ target: { value: 'example.com:443 *foo' } })
    assert.ok(textsOf(render()).some(text => text.includes('永远匹配不上')))
    await writeSettle()
    assert.equal(harness.writes.length, 1)
    assert.equal(harness.writes[0].ops[0].value, 'example.com:443 *foo')
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
    const harness = mountPlugin(mod, { value: { providers: {} } })
    const [, render] = renderPage(mod, harness)
    await settle()
    assert.ok(textsOf(render()).includes('没有检测到任何 provider。'))
  } finally {
    restore()
  }
})

test('the page says it is loading instead of claiming there are no providers', async () => {
  let release
  const { mod, restore } = loadBundle(async () => {
    await new Promise(resolve => { release = resolve })
    return {
      ok: true,
      status: 200,
      json: async () => ({ providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] }),
    }
  })
  try {
    const harness = mountPlugin(mod, { value: { providers: {} } })
    const [first, render] = renderPage(mod, harness)
    const loading = textsOf(first)
    assert.ok(
      loading.includes('正在读取 provider 列表…'),
      'an in-flight first read is a loading state, not an empty result',
    )
    assert.ok(!loading.includes('没有检测到任何 provider。'))

    release()
    await settle()
    const loaded = textsOf(render())
    assert.ok(loaded.includes('sensenova'), 'the catalogue arrives after the read')
    assert.ok(!loaded.includes('正在读取 provider 列表…'), 'the loading message goes away')
  } finally {
    restore()
  }
})

test('a failing catalogue endpoint is shown as an error, not an empty list', async () => {
  const { mod, restore } = loadBundle(async () => ({ ok: false, status: 500, json: async () => ({}) }))
  try {
    const harness = mountPlugin(mod, { value: { providers: {} } })
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())
    assert.ok(texts.some(text => text.includes('读取 provider 列表失败')))
    assert.ok(texts.some(text => text.includes('Host answered 500')))
    assert.ok(!texts.includes('没有检测到任何 provider。'))
  } finally {
    restore()
  }
})

test('a failed catalogue keeps saved cards visible and says the list is stale', async () => {
  const { mod, restore } = loadBundle(async () => ({ ok: false, status: 500, json: async () => ({}) }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())
    assert.ok(
      texts.some(text => text.includes('provider 列表读取失败，下面显示的是已保存的配置')),
      'the failure must be visible even when configured cards can still be rendered',
    )
    assert.ok(texts.includes('sensenova'))
    assert.ok(texts.includes('openai'))
  } finally {
    restore()
  }
})

test('an enabled provider is marked proxied, an unconfigured one direct', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const tree = render()
    assert.equal(
      pillTextOf(cardFor(tree, 'sensenova')),
      '走代理',
      'sensenova is enabled in config',
    )
    assert.equal(pillTextOf(cardFor(tree, 'openai')), '直连', 'openai has no route yet')
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

test('N7: saved providers missing from the catalogue are named in diagnostics', async () => {
  const { mod, restore } = loadBundle(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      providers: [
        { id: 'sensenova', name: 'SenseNova', live: true },
        { id: 'openai', name: 'OpenAI', live: false },
      ],
    }),
  }))
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
          },
          openai: {
            enabled: false,
            protocol: 'http',
            host: '',
            port: 0,
            username: '',
            password: '',
          },
          anthropic: {
            enabled: true,
            protocol: 'http',
            host: '10.0.0.2',
            port: 7890,
            username: '',
            password: '',
          },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())
    const mismatch = texts.find(text => text.includes('已保存但未出现在 Host 目录中的 provider'))
    assert.ok(mismatch, 'the mismatch must be explained in diagnostics')
    assert.ok(mismatch.includes('anthropic'), 'the missing provider is named')
    assert.ok(!mismatch.includes('sensenova'), 'a published live provider is not missing')
    assert.ok(
      !mismatch.includes('openai'),
      'a published but inactive provider is not missing',
    )
    assert.ok(
      texts.some(text => text.includes('连接诊断 (1)')),
      'the informational mismatch counts as one diagnostic item',
    )
    assert.equal(harness.writes.length, 0, 'the notice never writes settings')
  } finally {
    restore()
  }
})

test('N7: the mismatch is silent while loading or after a catalogue failure', async () => {
  let release
  const { mod, restore } = loadBundle(async () => {
    await new Promise(resolve => { release = resolve })
    return {
      ok: true,
      status: 200,
      json: async () => ({ providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] }),
    }
  })
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
          },
          openai: {
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
    const [, render] = renderPage(mod, harness)
    assert.ok(
      !textsOf(render()).some(text => text.includes('已保存但未出现在 Host 目录中的 provider')),
      'an in-flight catalogue read is not evidence that providers are missing',
    )
    release()
    await settle()
    assert.ok(
      textsOf(render()).some(text => text.includes('已保存但未出现在 Host 目录中的 provider：openai')),
      'a successful read then shows the real mismatch',
    )
  } finally {
    restore()
  }
})

test('N7: a catalogue read failure does not accuse saved providers of being missing', async () => {
  const { mod, restore } = loadBundle(async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const texts = textsOf(render())
    assert.ok(texts.some(text => text.includes('provider 列表读取失败')))
    assert.ok(
      !texts.some(text => text.includes('已保存但未出现在 Host 目录中的 provider')),
      'a failed read says nothing about whether a provider exists',
    )
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

/** The self-check button, ignoring the password reveal control before it. */
function findTestButton(node) {
  return findButtons(node).find(button => textsOf(button).includes('测试'))
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
    // One switch (the route's own on/off) plus the endpoint-source picker,
    // which since 0.9.0 also carries the "use the default proxy" choice.
    assert.equal(sections.length, 2, `expected 2 cards, got ${sections.length}`)
    for (const id of ['sensenova', 'openai']) {
      const card = sections.find(s => textsOf(s).includes(id))
      assert.ok(card, `no card for ${id}`)
      const controls = findCheckboxes(card)
      assert.equal(controls.length, 1, `${id} must own the enable switch`)
      for (const label of ['为该 provider 启用代理', '端点来源', '类型', 'IP / 主机', '端口', '用户名']) {
        assert.ok(textsOf(card).includes(label), `${id} is missing its ${label} field`)
      }
      assert.ok(
        textsOf(cardFor(tree, id)).some(text => text.includes('预设：默认预设')),
        `${id} must offer the built-in default preset`,
      )
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

// ---- N5: a save failure is visible, and diagnostics never echo a secret ----

test('a refused write shows a page-level reason and still rolls back', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    harness.form.mutate = async () => { throw new Error('settings/conflict') }
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'sensenova')
    findInputsByPlaceholder(card, '127.0.0.1')[0].props.onChange({
      target: { value: '10.9.9.9' },
    })
    await writeSettle()
    const tree = render()
    const texts = textsOf(tree)
    assert.ok(
      texts.some(text => text.includes('保存失败：sensenova.host — settings/conflict')),
      'the failure is visible without opening diagnostics',
    )
    assert.equal(
      findInputsByPlaceholder(cardFor(tree, 'sensenova'), '127.0.0.1')[0].props.value,
      '10.0.0.1',
      'the refused draft still rolls back',
    )
    assert.ok(
      texts.includes('读取 provider 列表失败') === false,
      'a save failure must not be mixed with a catalogue failure',
    )
  } finally {
    restore()
  }
})

test('a later successful write clears the save failure', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    let fail = true
    harness.form.mutate = async ops => {
      if (fail && ops.some(op => op.path[op.path.length - 1] === 'host')) {
        throw new Error('settings/conflict')
      }
    }
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'sensenova')
    findInputsByPlaceholder(card, '127.0.0.1')[0].props.onChange({
      target: { value: '10.9.9.9' },
    })
    await writeSettle()
    assert.ok(textsOf(render()).some(text => text.includes('保存失败：')))

    fail = false
    findCheckboxes(cardFor(render(), 'sensenova')).find(box => box.props.checked === true)
      .props.onChange({ target: { checked: false } })
    await writeSettle()
    assert.ok(
      !textsOf(render()).some(text => text.includes('保存失败：')),
      'the ordered write queue lets the later success clear the earlier failure',
    )
  } finally {
    restore()
  }
})

test('the save-failure banner can be dismissed', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    harness.form.mutate = async () => { throw new Error('settings/conflict') }
    const [, render] = renderPage(mod, harness)
    await settle()
    findCheckboxes(cardFor(render(), 'sensenova')).find(box => box.props.checked === true)
      .props.onChange({ target: { checked: false } })
    await writeSettle()
    const close = findButtons(render()).find(button => textsOf(button).includes('关闭'))
    assert.ok(close, 'the banner offers a close button')
    close.props.onClick()
    assert.ok(!textsOf(render()).some(text => text.includes('保存失败：')))
  } finally {
    restore()
  }
})

test('multiple failures keep only the latest one', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    harness.form.mutate = async ops => {
      throw new Error(`refused ${ops[0].path[ops[0].path.length - 1]}`)
    }
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'sensenova')
    findInputsByPlaceholder(card, '127.0.0.1')[0].props.onChange({
      target: { value: '10.9.9.9' },
    })
    await writeSettle()
    findInputsByPlaceholder(cardFor(render(), 'sensenova'), '7890')[0].props.onChange({
      target: { value: '1234' },
    })
    await writeSettle()
    const alerts = []
    const walk = node => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      if (node.props?.role === 'alert') alerts.push(node)
      if (node.children) walk(node.children)
    }
    walk(render())
    assert.equal(alerts.length, 1, 'there is one page-level banner, not a stack')
    assert.ok(textsOf(alerts[0]).some(text => text.includes('sensenova.port')))
    assert.ok(!textsOf(alerts[0]).some(text => text.includes('sensenova.host')))
  } finally {
    restore()
  }
})

test('a saved password is hidden from the diagnostics', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'sensenova')
    assert.ok(card, 'expected the sensenova card')
    const inputs = []
    const walk = node => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      if (node.type === 'input' && node.props?.type === 'password') inputs.push(node)
      if (node.children) walk(node.children)
    }
    walk(card)
    const password = inputs[0]
    assert.ok(password, 'the card exposes a password input')
    password.props.onChange({ target: { value: 'hunter2-secret' } })
    await writeSettle()
    const next = render()
    const texts = textsOf(next)
    assert.ok(
      texts.some(text => text.includes('已保存 sensenova.password')),
      'the diagnostic names the saved field',
    )
    assert.ok(
      texts.some(text => text.includes('值已隐藏')),
      'the diagnostic never includes the saved value',
    )
    assert.ok(!texts.some(text => text.includes('hunter2-secret')), 'the password never reaches diagnostics')
  } finally {
    restore()
  }
})

test('a failed password write never echoes the password', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    harness.form.mutate = async ops => {
      throw new Error(`rejected value ${ops[0].value}`)
    }
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'sensenova')
    const inputs = []
    const walk = node => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) return node.forEach(walk)
      if (node.type === 'input' && node.props?.type === 'password') inputs.push(node)
      if (node.children) walk(node.children)
    }
    walk(card)
    inputs[0].props.onChange({ target: { value: 'hunter2-secret' } })
    await writeSettle()
    const tree = JSON.stringify(render())
    assert.ok(!tree.includes('hunter2-secret'), 'neither the banner nor diagnostics echo the secret')
    assert.ok(textsOf(render()).some(text => text.includes('保存失败：sensenova.password（值已隐藏）')))
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
    // The global settings block now also renders a checkbox above the cards, so
    // the provider toggle must be looked up inside its own card.
    const toggle = findCheckbox(cardFor(registrations[0].Component(), 'openai'))
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
    const harness = mountPlugin(mod, { value: { providers: {} } })
    const [, render] = renderPage(mod, harness)
    await settle()
    const out = render()
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
      texts.some(text => text.includes('预设：默认预设')),
      'every card must offer the built-in default preset as an endpoint source',
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
    assert.ok(textsOf(tree).includes('配置完整'), 'a configured default reads as complete')
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
      textsOf(card).some(text => text.includes('顶层默认代理配置不完整')),
      'the card must say why it is not proxied instead of showing empty inputs',
    )
    assert.ok(
      textsOf(card).some(text => text.includes('未填写代理地址')),
      'and it must name the REASON, so the user is sent to the right field',
    )
  } finally {
    restore()
  }
})

test('a scheme-carrying default explains THAT, not a missing host or port', async () => {
  // The card previously said "missing host or port" for every refusal, including
  // the ones where both are perfectly filled in — sending the user to the field
  // that was already right. The reason now comes from the shared predicate, so it
  // is the same sentence the Host records.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        defaultProxy: { protocol: 'http', host: 'https://1.2.3.4', port: 7890 },
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
      textsOf(card).some(text => text.includes('只能填 IPv4、IPv6 或域名')),
      'the card must name the scheme/path rule the host actually breaks',
    )
  } finally {
    restore()
  }
})

test('a half-filled default credential disables the bulk button and explains why', async () => {
  // The shared predicate must agree with the credential guards in
  // `buildRouteEntry`: a default carrying a username and no password builds NO
  // route, so calling it usable here would light the block green and enable a
  // button that just refuses every card it touches.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 7890, username: 'alice', password: '' },
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
    const [tree, render] = renderPage(mod, harness)
    const applyAll = findButtons(tree).find(button =>
      textsOf(button).some(text => text.includes('所有 provider 使用默认代理')),
    )
    assert.ok(applyAll)
    assert.equal(
      applyAll.props.disabled,
      true,
      'a default that builds no route must not be advertised as usable',
    )
    const card = cardFor(render(), 'sensenova')
    assert.ok(
      textsOf(card).some(text => text.includes('配置了代理用户名但没有密码')),
      'the card must name the half-filled credential, not a missing address',
    )
  } finally {
    restore()
  }
})

test('the default proxy host field flags an invalid host where it is typed', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        defaultProxy: { protocol: 'http', host: 'bad host', port: 7890, username: '', password: '' },
      },
    })
    const [tree] = renderPage(mod, harness)
    const texts = textsOf(tree)
    assert.ok(
      texts.some(text => text.includes('代理地址只能填 IPv4、IPv6 或域名')),
      'the reason belongs under the host input, not only on the block pill',
    )
    assert.ok(
      JSON.stringify(tree).includes('dsw-alias-state-error-primary'),
      'the invalid host takes the error colour',
    )
    assert.ok(texts.includes('未配置'), 'the default block itself remains unusable')
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

test('choosing the built-in default preset persists useDefault to its own route', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'sensenova')
    const picker = profileSelectOf(card)
    assert.ok(picker, 'the card offers the endpoint-source picker')
    picker.props.onChange({ target: { value: '__default__' } })
    await writeSettle()
    // BOTH binding fields travel in ONE write: `profileId` wins over
    // `useDefault`, so leaving the old preset id on disk would keep routing
    // through it (see the "switch back" regression below).
    assert.deepEqual(harness.writes[0].ops, [
      { op: 'set', path: ['providers', 'sensenova', 'profileId'], value: '' },
      { op: 'set', path: ['providers', 'sensenova', 'useDefault'], value: true },
    ])
    assert.equal(profileSelectOf(cardFor(render(), 'sensenova')).props.value, '__default__')
  } finally {
    restore()
  }
})

test('N14: switching a card OFF a preset actually clears profileId on disk', async () => {
  // Reported: bind a dead preset -> unreachable; switch back to the working
  // default preset -> STILL unreachable. The old code changed `profileId` in the
  // draft only and persisted `useDefault` alone, so the file kept
  // `profileId: 'clash2'` and — because profileId wins — every later request and
  // check kept going through the dead port.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, profileId: 'clash2', protocol: 'http', host: '', port: 0 },
        },
        proxyProfiles: { clash2: { protocol: 'http', host: '127.0.0.1', port: 8888 } },
        defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 7891 },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    assert.equal(profileSelectOf(cardFor(render(), 'sensenova')).props.value, 'clash2')

    profileSelectOf(cardFor(render(), 'sensenova')).props.onChange({
      target: { value: '__default__' },
    })
    await writeSettle()

    const ops = harness.writes[0].ops
    assert.deepEqual(
      ops.filter(op => op.path[op.path.length - 1] === 'profileId'),
      [{ op: 'set', path: ['providers', 'sensenova', 'profileId'], value: '' }],
      'the preset binding must be cleared on disk, not only in the draft',
    )
    assert.equal(
      ops.find(op => op.path[op.path.length - 1] === 'useDefault').value,
      true,
      'and the default preset must be selected in the same write',
    )
    const card = cardFor(render(), 'sensenova')
    assert.equal(profileSelectOf(card).props.value, '__default__')
    assert.ok(
      textsOf(card).some(text => text.includes('使用默认代理：http://127.0.0.1:7891')),
      'the card must now name the default endpoint, not the dead preset',
    )
  } finally {
    restore()
  }
})

test('N14: switching a card to custom fields also clears profileId on disk', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: {
            enabled: true,
            profileId: 'clash2',
            protocol: 'http',
            host: '10.0.0.1',
            port: 7890,
          },
        },
        proxyProfiles: { clash2: { protocol: 'http', host: '127.0.0.1', port: 8888 } },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    profileSelectOf(cardFor(render(), 'sensenova')).props.onChange({ target: { value: '' } })
    await writeSettle()
    assert.deepEqual(harness.writes[0].ops, [
      { op: 'set', path: ['providers', 'sensenova', 'profileId'], value: '' },
      { op: 'set', path: ['providers', 'sensenova', 'useDefault'], value: false },
    ])
    // The card falls back to ITS OWN fields, so they become editable again.
    assert.ok(textsOf(cardFor(render(), 'sensenova')).includes('IP / 主机'))
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
    assert.ok(findTestButton(card), 'a disabled route with a complete endpoint must offer the check')
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
      findTestButton(card),
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

test('pasting a URL keeps an explicitly written :80 / :443', async () => {
  const { mod, restore } = loadBundle()
  try {
    const { registrations, writes } = mountPlugin(mod)
    await settle()
    const card = cardFor(registrations[0].Component(), 'sensenova')
    const host = findInputsByPlaceholder(card, '127.0.0.1')[0]
    const fieldsOf = ops => Object.fromEntries(ops.map(op => [op.path[2], op.value]))

    paste(host, 'http://proxy.test:80')
    await writeSettle()
    assert.equal(
      fieldsOf(writes[0].ops).port,
      80,
      'WHATWG strips :80 for http; the port the user wrote must survive',
    )

    paste(host, 'https://proxy.test:443')
    await writeSettle()
    assert.equal(fieldsOf(writes[1].ops).port, 443)

    paste(host, 'http://[::1]:80')
    await writeSettle()
    assert.equal(fieldsOf(writes[2].ops).host, '::1')
    assert.equal(fieldsOf(writes[2].ops).port, 80)

    paste(host, 'http://proxy.test')
    await writeSettle()
    assert.equal(fieldsOf(writes[3].ops).port, 0, 'an omitted port is still not invented')
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

test('N8: the bulk label counts every provider, not just the filtered rows', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const label = () =>
      findButtons(render())
        .map(button => textsOf(button).join(''))
        .find(text => text.includes('所有 provider 使用默认代理'))

    assert.equal(label(), '所有 provider 使用默认代理（2）')
    findInputsByPlaceholder(render(), '按名称或 id 过滤…')[0].props.onChange({
      target: { value: 'sense' },
    })
    assert.equal(
      label(),
      '所有 provider 使用默认代理（2）',
      'filtering the list must not change how many providers the bulk action targets',
    )
  } finally {
    restore()
  }
})

test('N8: promoting over an inherited default asks before replacing it', async () => {
  const { mod, restore } = loadBundle()
  const previousWindow = globalThis.window
  try {
    const harness = mountPlugin(mod, {
      value: {
        defaultProxy: {
          protocol: 'http',
          host: '127.0.0.1',
          port: 7890,
          username: '',
          password: '',
        },
        providers: {
          sensenova: {
            enabled: true,
            protocol: 'http',
            host: '10.0.0.1',
            port: 7891,
            username: '',
            password: '',
          },
          openai: {
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
    const [, render] = renderPage(mod, harness)
    await settle()
    const calls = []
    globalThis.window.confirm = message => {
      calls.push(message)
      return false
    }
    const promote = findButtons(cardFor(render(), 'sensenova')).find(button =>
      textsOf(button).includes('设为默认代理'),
    )
    assert.ok(promote)
    promote.props.onClick()
    await writeSettle()
    assert.equal(calls.length, 1, 'replacing a default in use asks once')
    assert.equal(harness.writes.length, 0, 'cancelling must not write')

    globalThis.window.confirm = message => {
      calls.push(message)
      return true
    }
    findButtons(cardFor(render(), 'sensenova'))
      .find(button => textsOf(button).includes('设为默认代理'))
      .props.onClick()
    await writeSettle()
    assert.equal(calls.length, 2)
    assert.equal(harness.writes.length, 1, 'confirming writes the promoted endpoint once')
    assert.deepEqual(
      harness.writes[0].ops.map(op => [op.path[1], op.value]),
      [
        ['protocol', 'http'],
        ['host', '10.0.0.1'],
        ['port', 7891],
        ['username', ''],
        ['password', ''],
      ],
    )
  } finally {
    globalThis.window = previousWindow
    restore()
  }
})

test('N8: promoting does not prompt when no card inherits the default', async () => {
  const { mod, restore } = loadBundle()
  const previousWindow = globalThis.window
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    let asked = 0
    globalThis.window.confirm = () => {
      asked += 1
      return false
    }
    const promote = findButtons(cardFor(render(), 'sensenova')).find(button =>
      textsOf(button).includes('设为默认代理'),
    )
    assert.ok(promote)
    promote.props.onClick()
    await writeSettle()
    assert.equal(asked, 0, 'there is nothing to overwrite')
    assert.equal(harness.writes.length, 1, 'the unopposed promotion still writes')
  } finally {
    globalThis.window = previousWindow
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
      textsOf(button).some(text => text.includes('所有 provider 使用默认代理')),
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
      textsOf(button).some(text => text.includes('所有 provider 使用默认代理')),
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
      textsOf(button).some(text => text.includes('所有 provider 使用默认代理')),
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

test('N9: status filter chips render counts and filter the visible providers', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      settings: {
        providers: {
          sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
          openai: { enabled: false, protocol: 'http', host: '', port: 0 },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()

    const chips = findButtons(render()).filter(b =>
      ['全部', '走代理', '直连', '配置被拒'].some(label => textsOf(b).some(t => t.includes(label))),
    )
    assert.strictEqual(chips.length, 4, 'four status filter chips should render')

    const proxiedChip = chips.find(b => textsOf(b).some(t => t.includes('走代理')))
    assert.ok(proxiedChip, 'proxied chip must be present')
    proxiedChip.props.onClick()

    assert.ok(cardFor(render(), 'sensenova'), 'sensenova is proxied and should remain visible')
    assert.equal(cardFor(render(), 'openai'), undefined, 'openai is direct and should be filtered out')
  } finally {
    restore()
  }
})

test('N10: compact view mode toggles and allows expanding individual cards', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      settings: {
        providers: {
          sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()

    const viewSwitch = findButtons(render()).find(b => textsOf(b).includes('紧凑视图'))
    assert.ok(viewSwitch, 'button offers switching to compact view')

    viewSwitch.props.onClick()
    assert.ok(findButtons(render()).find(b => textsOf(b).includes('卡片视图')), 'button toggled to Card view')

    const editBtn = findButtons(render()).find(b => textsOf(b).includes('编辑'))
    assert.ok(editBtn, 'compact row provides an Edit/Expand button')

    editBtn.props.onClick()
    assert.ok(findButtons(render()).find(b => textsOf(b).includes('收起')), 'button toggled to Collapse')
    assert.ok(findInputsUnderLabel(render(), 'IP / 主机').length > 0)
  } finally {
    restore()
  }
})

// ---- N18: two-line compact rows with an endpoint-source switch ----

/** One compact row (the `section` whose texts include a provider id). */
function compactRowFor(tree, id) {
  const rows = []
  const walk = node => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'section' && node.props?.key === `compact:${id}`) rows.push(node)
    if (node.children) walk(node.children)
  }
  walk(tree)
  return rows[0]
}

/** The `<section>`'s real children, without the null slots React keeps. */
function linesOf(row) {
  return (row?.children ?? []).filter(child => child !== null && child !== undefined)
}

/** Switch into compact view and return a render bound to the same hooks. */
async function renderCompact(mod, harness) {
  const [, render] = renderPage(mod, harness)
  await settle()
  findButtons(render()).find(button => textsOf(button).includes('紧凑视图')).props.onClick()
  return render
}

test('N18: a compact row is two lines before a check and three after one', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const render = await renderCompact(mod, harness)
    const row = compactRowFor(render(), 'sensenova')
    assert.ok(row, 'the compact row must render')
    // Two structural children by default: facts on top, controls underneath.
    // The result line only exists once there is a result to show.
    assert.equal(linesOf(row).length, 2, 'the row is two lines until a check reports')
    assert.equal(row.props.style.flexDirection, 'column')
  } finally {
    restore()
  }
})

test('N18: line one carries the proxy facts and no controls', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const render = await renderCompact(mod, harness)
    const [info] = compactRowFor(render(), 'sensenova').children
    const texts = textsOf(info)
    assert.ok(texts.includes('SenseNova'), 'the provider name is on line one')
    assert.ok(texts.includes('sensenova'), 'the provider id is on line one')
    assert.ok(
      texts.some(text => text.includes('http://10.0.0.1:7890')),
      'the resolved endpoint is on line one',
    )
    // Line one is read-only: no inputs, no buttons.
    assert.equal(findCheckboxes(info).length, 0, 'no switch on the info line')
    assert.equal(findButtons(info).length, 0, 'no buttons on the info line')
    assert.equal(findFirstNodeOfType(info, 'select'), undefined, 'no picker on the info line')
  } finally {
    restore()
  }
})

test('N18: line two carries the switch, the source picker and the actions', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
        },
        proxyProfiles: { 'HK-Proxy': { protocol: 'socks5', host: '127.0.0.1', port: 7891 } },
      },
    })
    const render = await renderCompact(mod, harness)
    const [, actions] = compactRowFor(render(), 'sensenova').children
    assert.equal(findCheckboxes(actions).length, 1, 'the enable switch moved to line two')
    const picker = findFirstNodeOfType(actions, 'select')
    assert.ok(picker, 'the endpoint-source picker is on line two')
    const options = textsOf(picker)
    assert.ok(options.some(text => text.includes('独立自定义配置')))
    assert.ok(options.some(text => text.includes('默认预设')))
    assert.ok(options.some(text => text.includes('HK-Proxy')))
    assert.equal(
      findButtons(actions).filter(button => textsOf(button).includes('测试')).length,
      1,
      'the Test button is on line two',
    )
    assert.ok(
      findButtons(actions).some(button => textsOf(button).includes('编辑')),
      'the expand control is on line two',
    )
  } finally {
    restore()
  }
})

test('N18: the compact endpoint source picker writes both binding fields', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
        },
        proxyProfiles: { 'HK-Proxy': { protocol: 'socks5', host: '127.0.0.1', port: 7891 } },
      },
    })
    const render = await renderCompact(mod, harness)
    const picker = findFirstNodeOfType(linesOf(compactRowFor(render(), 'sensenova'))[1], 'select')
    picker.props.onChange({ target: { value: 'HK-Proxy' } })
    await writeSettle()
    assert.deepEqual(harness.writes[0].ops, [
      { op: 'set', path: ['providers', 'sensenova', 'profileId'], value: 'HK-Proxy' },
      { op: 'set', path: ['providers', 'sensenova', 'useDefault'], value: false },
    ])
  } finally {
    restore()
  }
})

test('N18: after switching source in the compact row, line one shows the new endpoint', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
        },
        proxyProfiles: { 'HK-Proxy': { protocol: 'socks5', host: '127.0.0.1', port: 7891 } },
      },
    })
    const render = await renderCompact(mod, harness)
    findFirstNodeOfType(linesOf(compactRowFor(render(), 'sensenova'))[1], 'select')
      .props.onChange({ target: { value: 'HK-Proxy' } })
    const texts = textsOf(linesOf(compactRowFor(render(), 'sensenova'))[0])
    assert.ok(
      texts.some(text => text.includes('预设：HK-Proxy: socks5://127.0.0.1:7891')),
      'the info line must follow the switch immediately',
    )
    await writeSettle()
  } finally {
    restore()
  }
})

test('N18: a compact row bound to a missing preset says so on line one', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, profileId: 'gone', protocol: 'http', host: '', port: 0 },
        },
        proxyProfiles: {},
      },
    })
    const render = await renderCompact(mod, harness)
    const [info, actions] = compactRowFor(render(), 'sensenova').children
    assert.ok(
      textsOf(info).some(text => text.includes('gone') && text.includes('已缺失')),
      'the gap must be visible without expanding the row',
    )
    assert.equal(
      findFirstNodeOfType(actions, 'select').props.value,
      'gone',
      'the picker still shows the missing binding instead of a blank value',
    )
  } finally {
    restore()
  }
})

test('N18: a test result lands on its own third line, clear of the controls', async () => {
  // Requested: show the check result on a third line. Keeping it out of the
  // control line means a running or failing check never shifts the picker or
  // the buttons, and a long failure message gets the full width.
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: true, ms: 88, status: 200, exitIp: '203.0.113.7' }
        : { providers: [{ id: 'sensenova', name: 'SenseNova', live: true }] },
  }))
  try {
    const harness = mountPlugin(mod)
    const render = await renderCompact(mod, harness)

    assert.equal(linesOf(compactRowFor(render(), 'sensenova')).length, 2, 'no result line before a check')

    findButtons(compactRowFor(render(), 'sensenova'))
      .find(button => textsOf(button).includes('测试'))
      .props.onClick()
    await settle()

    const row = compactRowFor(render(), 'sensenova')
    assert.equal(linesOf(row).length, 3, 'the result gets its own third line')
    const [, actions, result] = linesOf(row)
    assert.ok(
      textsOf(result).some(text => text.includes('88 ms')),
      'the latency lands on the result line',
    )
    assert.ok(textsOf(result).some(text => text.includes('HTTP 200')))
    assert.ok(textsOf(result).some(text => text.includes('203.0.113.7')))

    // The control line is unchanged by the result: same picker, same buttons,
    // and nothing of the outcome ended up in it.
    assert.ok(findFirstNodeOfType(actions, 'select'), 'the picker stays on line two')
    assert.ok(
      findButtons(actions).some(button => textsOf(button).includes('测试')),
      'the Test button stays on line two',
    )
    assert.ok(
      !textsOf(actions).some(text => text.includes('88 ms')),
      'the outcome must not be printed on the control line',
    )
    // And the result can be copied from where it is shown.
    assert.ok(
      findButtons(result).some(button => button.props['aria-label'] === '复制'),
      'the exit IP on the result line can be copied',
    )
  } finally {
    restore()
  }
})

test('N11: form grid renders responsive two-column layout in default proxy and card forms', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      settings: {
        providers: {
          sensenova: { enabled: true, useDefault: false, protocol: 'socks5', host: '10.0.0.1', port: 1080 },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()

    const tree = render()
    function findNodes(node, pred, out = []) {
      if (node === null || typeof node !== 'object') return out
      if (Array.isArray(node)) {
        node.forEach(n => findNodes(n, pred, out))
        return out
      }
      if (pred(node)) out.push(node)
      if (node.children) findNodes(node.children, pred, out)
      return out
    }

    const formGrids = findNodes(
      tree,
      n => n.props?.style?.gridTemplateColumns === 'repeat(2, minmax(0, 1fr))',
    )
    assert.ok(formGrids.length >= 2, 'both default proxy block and custom cards use two-column grid')
    assert.strictEqual(
      findNodes(cardFor(tree, 'sensenova'), n => n.props?.style?.gridTemplateColumns === 'repeat(2, minmax(0, 1fr))').length,
      1,
      'card renders its endpoint fields inside a two-column grid',
    )

    const fullWidthLabels = findNodes(
      tree,
      n => n.props?.style?.gridColumn === '1 / -1' && n.type === 'label',
    )
    assert.ok(fullWidthLabels.length >= 2, 'password fields span both columns with fullWidth grid-column')
  } finally {
    restore()
  }
})

test('N12: batch test button runs checks for all enabled providers with progress', async () => {
  const { mod, restore } = loadBundle(async url => {
    if (url === '/dsh-provider-proxy/test') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, status: 200, ms: 88, exitIp: '1.2.3.4' }),
      }
    }
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
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
          openai: { enabled: true, protocol: 'http', host: '10.0.0.2', port: 7890 },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()

    const batchBtn = findButtons(render()).find(b => textsOf(b).some(t => t.includes('测试已启用 (2)')))
    assert.ok(batchBtn, 'batch test button shows active count 2')

    batchBtn.props.onClick()
    await settle()

    assert.ok(textsOf(cardFor(render(), 'sensenova')).some(t => t.includes('88 ms')))
    assert.ok(textsOf(cardFor(render(), 'openai')).some(t => t.includes('88 ms')))
  } finally {
    restore()
  }
})

test('N13: copy button copies text to clipboard and shows feedback', async () => {
  let copiedText = ''
  const previousClipboard = globalThis.navigator?.clipboard
  if (!globalThis.navigator) (globalThis as any).navigator = {}
  ;(globalThis.navigator as any).clipboard = {
    writeText: async (text: string) => {
      copiedText = text
    },
  }

  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()

    const testBtn = findButtons(cardFor(render(), 'sensenova')).find(b => textsOf(b).includes('测试'))
    assert.ok(testBtn)
    testBtn.props.onClick()
    await settle()

    const copyBtns = findButtons(cardFor(render(), 'sensenova')).filter(b => b.props['aria-label'] === '复制')
    assert.ok(copyBtns.length > 0, 'copy button rendered')

    copyBtns[0].props.onClick({ stopPropagation() {} })
    await settle()

    assert.ok(copiedText.length > 0, 'text was copied to clipboard')
    assert.ok(textsOf(cardFor(render(), 'sensenova')).some(t => t.includes('已复制')), 'feedback badge displayed')
  } finally {
    if (previousClipboard) (globalThis.navigator as any).clipboard = previousClipboard
    else delete (globalThis as any).navigator.clipboard
    restore()
  }
})

test('N14: form hints such as hostHint and passwordHint carry the warning/tip color token and fallback in both inline style and stylesheet', async () => {
  assert.match(
    clientCss,
    /\.hint\s*\{[^}]*color:\s*var\(--dsw-alias-state-warn-primary,\s*#d29922\)/,
    'client.css defines .hint color with fallback #d29922',
  )

  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 7890 },
        providers: {
          sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()

    function findNodes(node: any, pred: (n: any) => boolean, out: any[] = []): any[] {
      if (node === null || typeof node !== 'object') return out
      if (Array.isArray(node)) {
        node.forEach(n => findNodes(n, pred, out))
        return out
      }
      if (pred(node)) out.push(node)
      if (node.children) findNodes(node.children, pred, out)
      return out
    }

    const tree = render()

    const hostHintNodes = findNodes(
      tree,
      n => n.type === 'span' && textsOf(n).some(t => t.includes('仅限 IP 或域名')),
    )
    assert.ok(hostHintNodes.length >= 1, 'found host hint node')
    for (const node of hostHintNodes) {
      assert.strictEqual(
        node.props?.style?.color,
        'var(--dsw-alias-state-warn-primary, #d29922)',
        'host hint carries state-warn-primary color with fallback',
      )
    }

    const passwordHintNodes = findNodes(
      tree,
      n => n.type === 'span' && textsOf(n).some(t => t.includes('作为代理认证口令')),
    )
    assert.ok(passwordHintNodes.length >= 1, 'found password hint node')
    for (const node of passwordHintNodes) {
      assert.strictEqual(
        node.props?.style?.color,
        'var(--dsw-alias-state-warn-primary, #d29922)',
        'password hint carries state-warn-primary color with fallback',
      )
    }

    const globalTestUrlHintNodes = findNodes(
      tree,
      n => n.type === 'span' && textsOf(n).some(t => t.includes('逗号或空格分隔；按顺序尝试')),
    )
    assert.ok(globalTestUrlHintNodes.length >= 1, 'found global testUrl hint node')
    for (const node of globalTestUrlHintNodes) {
      assert.strictEqual(
        node.props?.style?.color,
        'var(--dsw-alias-state-warn-primary, #d29922)',
        'global testUrl hint carries state-warn-primary color with fallback',
      )
    }
  } finally {
    restore()
  }
})

// ---- N14: named proxy presets ----

/** The preset manager block, by its summary text. */
function profileManagerOf(tree) {
  let found
  const walk = node => {
    if (found !== undefined || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'details' && textsOf(node).includes('代理预设 (0)')) found = node
    if (found === undefined && node.type === 'details') {
      const summary = textsOf(node.children?.[0]).join('')
      if (summary.startsWith('代理预设')) found = node
    }
    if (node.children) walk(node.children)
  }
  walk(tree)
  return found
}

/** The `<select>` a card uses to pick its endpoint source. */
function profileSelectOf(card) {
  const selects = []
  const walk = node => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'select') selects.push(node)
    if (node.children) walk(node.children)
  }
  walk(card)
  return selects.find(select => textsOf(select).some(text => text.includes('独立自定义配置')))
}

test('N14: the preset manager is a details block that lists the built-in default', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [tree] = renderPage(mod, harness)
    const manager = profileManagerOf(tree)
    assert.ok(manager, 'the page must offer a preset manager block')
    assert.equal(manager.type, 'details')
    assert.ok(
      textsOf(manager).some(text => text.includes('默认预设 (Default)')),
      'the built-in default preset must be discoverable from the manager',
    )
    assert.ok(
      findButtons(manager).some(button => textsOf(button).includes('添加预设')),
      'the manager must offer an add button',
    )
  } finally {
    restore()
  }
})

test('N14: with no named presets a card still offers own fields and the built-in default', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [tree] = renderPage(mod, harness)
    const card = cardFor(tree, 'sensenova')
    assert.equal(findCheckboxes(card).length, 1, 'the enable switch is the only checkbox')
    const select = profileSelectOf(card)
    assert.ok(select, 'the endpoint-source picker is always available')
    const options = textsOf(select)
    assert.ok(options.some(text => text.includes('独立自定义配置')))
    assert.ok(options.some(text => text.includes('默认预设')))
    assert.equal(options.filter(text => text.includes('预设：')).length, 1, 'no named preset yet')
  } finally {
    restore()
  }
})

test('N14: once a preset exists, a card picks its endpoint source from a list', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
        },
        proxyProfiles: { 'HK-Proxy': { protocol: 'socks5', host: '127.0.0.1', port: 7891 } },
      },
    })
    const [tree] = renderPage(mod, harness)
    const card = cardFor(tree, 'sensenova')
    const select = profileSelectOf(card)
    assert.ok(select, 'the card must offer a preset picker')
    const options = textsOf(select)
    assert.ok(options.some(text => text.includes('独立自定义配置')), 'the own-fields option is offered')
    assert.ok(options.some(text => text.includes('默认预设')), 'the default preset is offered')
    assert.ok(options.some(text => text.includes('HK-Proxy')), 'each named preset is offered')
    assert.ok(
      options.some(text => text.includes('127.0.0.1:7891')),
      'each option names the address it will use',
    )
    assert.equal(select.props.value, '', 'a route with no binding starts on its own fields')
  } finally {
    restore()
  }
})

test('N14: binding a card to a preset writes both binding fields in one go', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
        },
        proxyProfiles: { 'HK-Proxy': { protocol: 'socks5', host: '127.0.0.1', port: 7891 } },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    const select = profileSelectOf(cardFor(render(), 'sensenova'))
    select.props.onChange({ target: { value: 'HK-Proxy' } })
    await writeSettle()
    assert.deepEqual(harness.writes[0].ops, [
      { op: 'set', path: ['providers', 'sensenova', 'profileId'], value: 'HK-Proxy' },
      { op: 'set', path: ['providers', 'sensenova', 'useDefault'], value: false },
    ])
  } finally {
    restore()
  }
})

test('N14: a card bound to a preset hides its own inputs and names the endpoint', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, profileId: 'HK-Proxy', protocol: 'http', host: '', port: 0 },
        },
        proxyProfiles: { 'HK-Proxy': { protocol: 'socks5', host: '127.0.0.1', port: 7891 } },
      },
    })
    const [tree] = renderPage(mod, harness)
    const card = cardFor(tree, 'sensenova')
    assert.ok(
      textsOf(card).includes('使用预设 HK-Proxy：socks5://127.0.0.1:7891'),
      'the card must name the endpoint it will actually use',
    )
    assert.ok(
      !textsOf(card).includes('IP / 主机'),
      'a bound card must not render inputs that do not apply',
    )
    assert.equal(pillTextOf(card), '走代理', 'a resolvable preset is not a refusal')
  } finally {
    restore()
  }
})

test('N14: a card bound to a missing preset is refused and names it', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, profileId: 'deleted-one', protocol: 'http', host: '', port: 0 },
        },
        proxyProfiles: {},
      },
    })
    const [tree] = renderPage(mod, harness)
    const card = cardFor(tree, 'sensenova')
    assert.equal(pillTextOf(card), '配置被拒')
    assert.ok(
      textsOf(card).some(text => text.includes('绑定的预设「deleted-one」已不存在')),
      'the refusal must name the missing preset, not the card fields',
    )
    // The Test button stays, exactly as it does for any enabled route: the Host
    // is the one that can explain WHY the route was refused, and it answers with
    // the same missing-preset reason.
    assert.ok(findTestButton(card), 'an enabled route always offers the check')
  } finally {
    restore()
  }
})

test('N14: a card bound to an unusable preset says the PRESET is at fault', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, profileId: 'HK-Proxy', protocol: 'http', host: '', port: 0 },
        },
        proxyProfiles: { 'HK-Proxy': { protocol: 'http', host: '127.0.0.1', port: 0 } },
      },
    })
    const [tree] = renderPage(mod, harness)
    const card = cardFor(tree, 'sensenova')
    assert.ok(
      textsOf(card).some(text => text.includes('绑定的预设「HK-Proxy」不可用')),
      'the refusal must point at the preset',
    )
    assert.ok(
      textsOf(card).some(text => text.includes('代理端口无效')),
      'and it must still name the actual problem',
    )
  } finally {
    restore()
  }
})

test('N14: adding a preset writes the whole preset dictionary', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const manager = profileManagerOf(render())
    const nameInput = findInputsByPlaceholder(manager, '新预设名称，例如 HK-Proxy')[0]
    assert.ok(nameInput, 'the manager must offer an inline name field')
    nameInput.props.onChange({ target: { value: 'HK-Proxy' } })
    const add = findButtons(profileManagerOf(render())).find(button =>
      textsOf(button).includes('添加预设'),
    )
    add.props.onClick()
    await writeSettle()
    assert.deepEqual(harness.writes[0].ops, [
      {
        op: 'set',
        path: ['proxyProfiles'],
        value: { 'HK-Proxy': { protocol: 'http', host: '', port: 0, username: '', password: '' } },
      },
    ])
    assert.ok(
      textsOf(render()).some(text => text.includes('HK-Proxy')),
      'the new preset must appear immediately, before a remount',
    )
  } finally {
    restore()
  }
})

test('N14: a duplicate preset name is refused without a write', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {},
        proxyProfiles: { 'HK-Proxy': { protocol: 'http', host: '127.0.0.1', port: 7891 } },
      },
    })
    const [, render] = renderPage(mod, harness)
    findInputsByPlaceholder(profileManagerOf(render()), '新预设名称，例如 HK-Proxy')[0]
      .props.onChange({ target: { value: 'HK-Proxy' } })
    findButtons(profileManagerOf(render()))
      .find(button => textsOf(button).includes('添加预设'))
      .props.onClick()
    await writeSettle()
    assert.equal(harness.writes.length, 0, 'a duplicate name must not reach the Host')
    assert.ok(textsOf(render()).some(text => text.includes('已存在同名预设')))
  } finally {
    restore()
  }
})

test('N14: editing a preset field writes its own path and clears bound checks', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () =>
      String(url).includes('/test')
        ? { ok: true, ms: 120, status: 200 }
        : {
            providers: [
              { id: 'sensenova', name: 'SenseNova', live: true },
              { id: 'openai', name: 'OpenAI', live: true },
            ],
          },
  }))
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, profileId: 'HK-Proxy', protocol: 'http', host: '', port: 0 },
          openai: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
        },
        proxyProfiles: { 'HK-Proxy': { protocol: 'http', host: '127.0.0.1', port: 7891 } },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    for (const id of ['sensenova', 'openai']) {
      findTestButton(cardFor(render(), id)).props.onClick()
    }
    await settle()
    assert.ok(JSON.stringify(cardFor(render(), 'sensenova')).includes('120 ms'))
    assert.ok(JSON.stringify(cardFor(render(), 'openai')).includes('120 ms'))

    const manager = profileManagerOf(render())
    const host = findInputsByPlaceholder(manager, '127.0.0.1')[0]
    assert.ok(host, 'the preset manager exposes the preset host input')
    host.props.onChange({ target: { value: '10.0.0.9' } })
    const tree = render()
    assert.ok(
      !JSON.stringify(cardFor(tree, 'sensenova')).includes('120 ms'),
      'a card bound to the edited preset must lose its check result',
    )
    assert.ok(
      JSON.stringify(cardFor(tree, 'openai')).includes('120 ms'),
      'a card with its own endpoint is unaffected',
    )
    await writeSettle()
    assert.deepEqual(harness.writes[0].ops, [
      { op: 'set', path: ['proxyProfiles', 'HK-Proxy', 'host'], value: '10.0.0.9' },
    ])
  } finally {
    restore()
  }
})

test('N14: deleting a preset in use warns and carries the bound providers with it', async () => {
  let confirmText
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, profileId: 'HK-Proxy', protocol: 'http', host: '', port: 0 },
        },
        proxyProfiles: { 'HK-Proxy': { protocol: 'http', host: '127.0.0.1', port: 7891 } },
      },
    })
    // The real settings store republishes the value after a write; this harness
    // records writes only, so the delete is mirrored here to observe the page
    // AFTER the preset is gone.
    const mutate = harness.form.mutate
    harness.form.mutate = async (ops, revision) => {
      await mutate(ops, revision)
      for (const op of ops) {
        if (op.op === 'set' && op.path[0] === 'proxyProfiles') harness.snapshot.value.proxyProfiles = op.value
      }
    }
    const [, render] = renderPage(mod, harness)
    globalThis.window = {
      ...globalThis.window,
      confirm: text => {
        confirmText = text
        return true
      },
    }
    const remove = findButtons(profileManagerOf(render())).find(button =>
      textsOf(button).includes('删除'),
    )
    assert.ok(remove, 'each preset row offers a delete button')
    remove.props.onClick()
    assert.ok(
      String(confirmText).includes('sensenova'),
      'the warning must name the providers that depend on the preset',
    )
    await writeSettle()
    assert.deepEqual(harness.writes[0].ops, [{ op: 'set', path: ['proxyProfiles'], value: {} }])
    const card = cardFor(render(), 'sensenova')
    assert.equal(pillTextOf(card), '配置被拒', 'the bound card is now refused')
    assert.ok(textsOf(card).some(text => text.includes('已不存在')))
  } finally {
    restore()
  }
})

test('N14: a cancelled delete writes nothing', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {},
        proxyProfiles: { 'HK-Proxy': { protocol: 'http', host: '127.0.0.1', port: 7891 } },
      },
    })
    const [, render] = renderPage(mod, harness)
    globalThis.window = { ...globalThis.window, confirm: () => false }
    findButtons(profileManagerOf(render()))
      .find(button => textsOf(button).includes('删除'))
      .props.onClick()
    await writeSettle()
    assert.equal(harness.writes.length, 0)
  } finally {
    restore()
  }
})

test('N14: renaming a preset moves the key and rebinds every route using it', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, profileId: 'HK-Proxy', protocol: 'http', host: '', port: 0 },
        },
        proxyProfiles: { 'HK-Proxy': { protocol: 'http', host: '127.0.0.1', port: 7891 } },
      },
    })
    const [, render] = renderPage(mod, harness)
    // Rename is inline: open the field, type, then confirm — the same three
    // steps a user performs. `window.prompt` cannot be used here because the
    // Desktop host does not implement it.
    findButtons(profileManagerOf(render()))
      .find(button => textsOf(button).includes('重命名'))
      .props.onClick()
    const renameInput = findInputsByPlaceholder(
      profileManagerOf(render()),
      '该代理预设的新名称：',
    )[0]
    assert.ok(renameInput, 'the rename field must appear in place')
    assert.equal(renameInput.props.value, 'HK-Proxy', 'it starts from the current name')
    renameInput.props.onChange({ target: { value: 'HK-Fast' } })
    findButtons(profileManagerOf(render()))
      .find(button => textsOf(button).includes('保存名称'))
      .props.onClick()
    await writeSettle()
    assert.deepEqual(harness.writes[0].ops, [
      {
        op: 'set',
        path: ['proxyProfiles'],
        value: { 'HK-Fast': { protocol: 'http', host: '127.0.0.1', port: 7891, username: '', password: '' } },
      },
      { op: 'set', path: ['providers', 'sensenova', 'profileId'], value: 'HK-Fast' },
    ])
    assert.ok(
      textsOf(cardFor(render(), 'sensenova')).some(text => text.includes('使用预设 HK-Fast')),
      'the card follows the rename without a remount',
    )
  } finally {
    restore()
  }
})

test('N14: adding a preset works where window.prompt does not exist', async () => {
  // The Desktop host does not implement `window.prompt` — calling it throws and
  // a button wired to it does nothing at all, which is exactly how "clicking Add
  // preset has no effect" was reported. The manager must not depend on it.
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    assert.equal(typeof globalThis.window?.prompt, 'undefined', 'the fixture has no prompt')

    findInputsByPlaceholder(profileManagerOf(render()), '新预设名称，例如 HK-Proxy')[0]
      .props.onChange({ target: { value: 'HK-Proxy' } })
    findButtons(profileManagerOf(render()))
      .find(button => textsOf(button).includes('添加预设'))
      .props.onClick()
    await writeSettle()

    assert.equal(harness.writes.length, 1, 'the add must actually reach the Host')
    assert.deepEqual(Object.keys(harness.writes[0].ops[0].value), ['HK-Proxy'])
    assert.ok(
      textsOf(profileManagerOf(render())).includes('HK-Proxy'),
      'the new row must be visible in the manager',
    )
  } finally {
    restore()
  }
})

test('N14: the manager opens itself when a preset is added', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    assert.equal(profileManagerOf(render()).props.open, false, 'collapsed by default')

    findInputsByPlaceholder(profileManagerOf(render()), '新预设名称，例如 HK-Proxy')[0]
      .props.onChange({ target: { value: 'HK-Proxy' } })
    findButtons(profileManagerOf(render()))
      .find(button => textsOf(button).includes('添加预设'))
      .props.onClick()

    assert.equal(
      profileManagerOf(render()).props.open,
      true,
      'a new row inside a collapsed block would still read as "nothing happened"',
    )
    await writeSettle()
  } finally {
    restore()
  }
})

test('N14: an empty name is reported instead of silently doing nothing', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    findButtons(profileManagerOf(render()))
      .find(button => textsOf(button).includes('添加预设'))
      .props.onClick()
    await writeSettle()
    assert.equal(harness.writes.length, 0)
    assert.ok(
      textsOf(render()).some(text => text.includes('保存失败：') && text.includes('不能为空')),
      'the reason must be visible, otherwise the click still looks dead',
    )
  } finally {
    restore()
  }
})

// ---- N15: quick import from common local clients and the environment ----

/** The quick-import picker whose subtree contains one option label. */
function quickImportOf(node, label) {
  const selects = []
  const walk = current => {
    if (current === null || typeof current !== 'object') return
    if (Array.isArray(current)) return current.forEach(walk)
    if (current.type === 'select') selects.push(current)
    if (current.children) walk(current.children)
  }
  walk(node)
  return selects.find(select => textsOf(select).some(text => text.includes(label)))
}

test('N15: the default block offers the common-client presets', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [tree] = renderPage(mod, harness)
    const picker = quickImportOf(tree, 'Clash / Mihomo')
    assert.ok(picker, 'the page must offer a quick-import picker')
    const options = textsOf(picker)
    for (const label of [
      'Clash / Mihomo (127.0.0.1:7890)',
      'Clash Verge / Meta (127.0.0.1:7897)',
      'V2Ray / Xray HTTP (127.0.0.1:10809)',
      'V2Ray / Xray SOCKS5 (127.0.0.1:10808)',
    ]) {
      assert.ok(options.includes(label), `missing preset: ${label}`)
    }
  } finally {
    restore()
  }
})

test('N15: choosing Clash fills protocol, host and port in ONE write', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const picker = quickImportOf(render(), 'Clash / Mihomo')
    picker.props.onChange({ target: { value: 'clash' } })
    await writeSettle()
    assert.deepEqual(harness.writes[0].ops, [
      { op: 'set', path: ['defaultProxy', 'protocol'], value: 'http' },
      { op: 'set', path: ['defaultProxy', 'host'], value: '127.0.0.1' },
      { op: 'set', path: ['defaultProxy', 'port'], value: 7890 },
    ])
    const host = findInputsOutsideSections(render(), '127.0.0.1')[0]
    assert.equal(host.props.value, '127.0.0.1', 'the field shows the imported value immediately')
  } finally {
    restore()
  }
})

test('N15: the V2Ray SOCKS5 preset imports port 10808 and socks5', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    quickImportOf(render(), 'V2Ray / Xray SOCKS5').props.onChange({ target: { value: 'v2ray-socks' } })
    await writeSettle()
    const ops = harness.writes[0].ops
    assert.deepEqual(
      ops.map(op => [op.path[op.path.length - 1], op.value]),
      [
        ['protocol', 'socks5'],
        ['host', '127.0.0.1'],
        ['port', 10808],
      ],
    )
  } finally {
    restore()
  }
})

test('N15: a card quick-import fills THAT card, not the shared default', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'openai')
    quickImportOf(card, 'Clash Verge / Meta').props.onChange({ target: { value: 'clash-verge' } })
    await writeSettle()
    assert.deepEqual(
      harness.writes[0].ops.map(op => op.path),
      [
        ['providers', 'openai', 'protocol'],
        ['providers', 'openai', 'host'],
        ['providers', 'openai', 'port'],
      ],
    )
    assert.equal(harness.writes[0].ops[2].value, 7897)
  } finally {
    restore()
  }
})

test('N15: a preset row can import a client into that preset', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {},
        proxyProfiles: { 'HK-Proxy': { protocol: 'http', host: '', port: 0 } },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    const manager = profileManagerOf(render())
    quickImportOf(manager, 'V2Ray / Xray HTTP').props.onChange({ target: { value: 'v2ray-http' } })
    await writeSettle()
    assert.deepEqual(
      harness.writes[0].ops.map(op => [op.path.join('.'), op.value]),
      [
        ['proxyProfiles.HK-Proxy.protocol', 'http'],
        ['proxyProfiles.HK-Proxy.host', '127.0.0.1'],
        ['proxyProfiles.HK-Proxy.port', 10809],
      ],
    )
  } finally {
    restore()
  }
})

test('N15: the environment option applies the Host-detected endpoint', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () => ({
      providers: [],
      environment: {
        proxy: { source: 'ALL_PROXY', protocol: 'socks5', host: '10.1.2.3', port: 1080, hadCredentials: false },
      },
    }),
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const picker = quickImportOf(render(), '从环境变量')
    assert.ok(picker, 'the detected environment must be offered')
    picker.props.onChange({ target: { value: 'environment' } })
    await writeSettle()
    assert.deepEqual(
      harness.writes[0].ops.map(op => [op.path[op.path.length - 1], op.value]),
      [
        ['protocol', 'socks5'],
        ['host', '10.1.2.3'],
        ['port', 1080],
      ],
    )
  } finally {
    restore()
  }
})

test('N15: without a detected environment the option is disabled, not broken', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () => ({ providers: [], environment: { proxy: null } }),
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const picker = quickImportOf(render(), '从环境变量（未检测到）')
    assert.ok(picker, 'the option still explains that nothing was found')
    const option = picker.children.find(child => child?.props?.value === 'environment')
    assert.equal(option.props.disabled, true, 'a missing environment must not be selectable')
    assert.equal(harness.writes.length, 0)
  } finally {
    restore()
  }
})

test('N15: an environment credential is announced instead of silently dropped', async () => {
  const { mod, restore } = loadBundle(async url => ({
    ok: true,
    status: 200,
    json: async () => ({
      providers: [],
      environment: {
        proxy: { source: 'HTTPS_PROXY', protocol: 'http', host: 'p.test', port: 8080, hadCredentials: true },
      },
    }),
  }))
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    assert.ok(
      textsOf(render()).some(text => text.includes('该环境变量还带了凭据')),
      'the page must ask for the credential it did not import',
    )
  } finally {
    restore()
  }
})

// ---- N16: official provider host templates ----

test('N16: a known provider offers its official-upstream pill', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [tree] = renderPage(mod, harness)
    const card = cardFor(tree, 'openai')
    const pill = findButtons(card).find(button =>
      textsOf(button).some(text => text.includes('载入官方上游域名')),
    )
    assert.ok(pill, 'an OpenAI card must offer the template pill')
    assert.ok(
      textsOf(pill).some(text => text.includes('api.openai.com')),
      'the pill names the hosts it will load',
    )
  } finally {
    restore()
  }
})

test('N16: the pill fills onlyHosts and the result has no dead entry', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const card = cardFor(render(), 'openai')
    const pill = findButtons(card).find(button =>
      textsOf(button).some(text => text.includes('载入官方上游域名')),
    )
    pill.props.onClick()
    await writeSettle()
    assert.deepEqual(harness.writes[0].ops, [
      { op: 'set', path: ['providers', 'openai', 'onlyHosts'], value: 'api.openai.com, *.openai.com' },
    ])

    const after = cardFor(render(), 'openai')
    assert.ok(
      !textsOf(after).some(text => text.includes('永远匹配不上')),
      'the loaded template must not be flagged as a dead rule',
    )
    const onlyHostsInput = findInputsUnderLabel(after, '仅走代理')[0]
    assert.equal(onlyHostsInput.props.value, 'api.openai.com, *.openai.com')
  } finally {
    restore()
  }
})

test('N16: loading a template into an existing rule keeps the card rule', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          anthropic: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890, onlyHosts: 'relay.internal' },
        },
      },
    })
    const [, render] = renderPage(mod, harness)
    await settle()
    findButtons(cardFor(render(), 'anthropic'))
      .find(button => textsOf(button).some(text => text.includes('载入官方上游域名')))
      .props.onClick()
    await writeSettle()
    assert.equal(
      harness.writes[0].ops[0].value,
      'relay.internal, api.anthropic.com',
      'the relay host the user already chose must survive',
    )
  } finally {
    restore()
  }
})

test('N16: an unknown provider shows no template pill', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [tree] = renderPage(mod, harness)
    const card = cardFor(tree, 'sensenova')
    assert.ok(
      !findButtons(card).some(button => textsOf(button).some(text => text.includes('载入官方上游域名'))),
      'a provider with no known upstream must not be offered a guess',
    )
  } finally {
    restore()
  }
})

// ---- N17: configuration backup and restore ----

/**
 * Replace the browser globals the export path needs.
 *
 * `Blob`, `URL.createObjectURL` and an anchor are the real download mechanism;
 * stubbing them is what lets the test read the exact bytes the user would get.
 */
function stubDownloadEnvironment(confirmAnswer = true) {
  const saved = {
    Blob: globalThis.Blob,
    URL: globalThis.URL,
    window: globalThis.window,
    setTimeout: globalThis.setTimeout,
    document: globalThis.document,
  }
  const state = { text: undefined, name: undefined, prompts: [] }
  globalThis.Blob = class {
    constructor(parts) {
      state.text = String(parts?.[0] ?? '')
    }
  }
  globalThis.URL = {
    ...saved.URL,
    createObjectURL: () => 'blob:fake',
    revokeObjectURL: () => {},
  }
  globalThis.setTimeout = fn => {
    fn()
    return 0
  }
  globalThis.window = {
    ...saved.window,
    confirm: text => {
      state.prompts.push(String(text))
      return confirmAnswer
    },
  }
  globalThis.document = {
    ...saved.document,
    createElement(tag) {
      if (tag !== 'a') return saved.document.createElement(tag)
      const anchor = {}
      Object.defineProperties(anchor, {
        href: { set() {} },
        download: {
          set(value) {
            state.name = value
          },
        },
      })
      anchor.click = () => {}
      return anchor
    },
  }
  return {
    state,
    /** The JSON the browser would have written to disk. */
    savedFile() {
      return state.text === undefined ? undefined : JSON.parse(state.text)
    },
    restore() {
      globalThis.Blob = saved.Blob
      globalThis.URL = saved.URL
      globalThis.window = saved.window
      globalThis.setTimeout = saved.setTimeout
      globalThis.document = saved.document
    },
  }
}

/** The backup toolbar, by its button labels. */
function backupBlockOf(tree) {
  const walk = node => {
    if (node === null || typeof node !== 'object') return undefined
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = walk(child)
        if (found !== undefined) return found
      }
      return undefined
    }
    if (node.props?.style?.flexWrap === 'wrap' && node.props?.key === 'backup') return node
    return node.children ? walk(node.children) : undefined
  }
  return walk(tree)
}

test('N17: the page offers both backup actions', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [tree] = renderPage(mod, harness)
    const block = backupBlockOf(tree)
    assert.ok(block, 'the backup toolbar must render')
    const labels = textsOf(block)
    assert.ok(labels.includes('备份配置'), 'an export button is offered')
    assert.ok(labels.includes('恢复配置'), 'an import control is offered')
  } finally {
    restore()
  }
})

test('N17: export asks about passwords and omits them when declined', async () => {
  const { mod, restore } = loadBundle()
  const download = stubDownloadEnvironment(false)
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: {
            enabled: true,
            protocol: 'http',
            host: '10.0.0.1',
            port: 7890,
            username: 'alice',
            password: 'hunter2',
          },
        },
        proxyProfiles: { HK: { protocol: 'http', host: '127.0.0.1', port: 7891, password: 'p2' } },
        defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 7890, password: 'p3' },
      },
    })
    const [tree] = renderPage(mod, harness)
    findButtons(backupBlockOf(tree))
      .find(button => textsOf(button).includes('备份配置'))
      .props.onClick()

    assert.ok(
      download.state.prompts.some(text => text.includes('是否包含代理密码')),
      'the export must ask about passwords every time',
    )
    const file = download.savedFile()
    assert.ok(file, 'the download must carry a JSON body')
    assert.match(download.state.name, /^dsh-proxy-backup-\d{4}-\d{2}-\d{2}\.json$/)
    assert.equal(file.providers.sensenova.password, '')
    assert.equal(file.proxyProfiles.HK.password, '')
    assert.equal(file.defaultProxy.password, '')
    assert.equal(file.providers.sensenova.username, 'alice', 'non-secret fields are untouched')
    assert.equal(JSON.stringify(file).includes('hunter2'), false)
  } finally {
    download.restore()
    restore()
  }
})

test('N17: accepting the prompt keeps the passwords in the export', async () => {
  const { mod, restore } = loadBundle()
  const download = stubDownloadEnvironment(true)
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: {
            enabled: true,
            protocol: 'http',
            host: '10.0.0.1',
            port: 7890,
            username: 'alice',
            password: 'hunter2',
          },
        },
      },
    })
    const [tree] = renderPage(mod, harness)
    findButtons(backupBlockOf(tree))
      .find(button => textsOf(button).includes('备份配置'))
      .props.onClick()
    assert.equal(download.savedFile().providers.sensenova.password, 'hunter2')
  } finally {
    download.restore()
    restore()
  }
})

test('N17: an exported file round-trips into a single restore write', async () => {
  const { mod, restore } = loadBundle()
  const download = stubDownloadEnvironment(true)
  try {
    const harness = mountPlugin(mod, {
      value: {
        providers: {
          sensenova: { enabled: true, protocol: 'http', host: '10.0.0.1', port: 7890 },
        },
        proxyProfiles: { HK: { protocol: 'http', host: '127.0.0.1', port: 7891 } },
        localDirect: false,
        testUrl: 'https://echo.example/ip',
      },
    })
    let [, render] = renderPage(mod, harness)
    findButtons(backupBlockOf(render()))
      .find(button => textsOf(button).includes('备份配置'))
      .props.onClick()
    const exported = download.state.text
    assert.ok(exported)

    const input = findFirstNodeOfType(backupBlockOf(render()), 'input')
    assert.equal(input.props.type, 'file')
    await input.props.onChange({
      target: { files: [{ text: async () => exported }], value: 'C:\\fake.json' },
    })
    await settle()
    const writes = harness.writes.filter(write => write.ops.length > 1)
    assert.equal(writes.length, 1, 'a restore is ONE mutate call, so it cannot half apply')
    assert.deepEqual(
      writes[0].ops.map(op => op.path[0]),
      ['providers', 'proxyProfiles', 'defaultProxy', 'localDirect', 'testUrl'],
    )
    assert.equal(writes[0].ops[3].value, false, 'localDirect is restored, not defaulted')
    assert.equal(writes[0].ops[4].value, 'https://echo.example/ip')
  } finally {
    download.restore()
    restore()
  }
})

test('N17: a broken file is reported and nothing is written', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    const input = findFirstNodeOfType(backupBlockOf(render()), 'input')
    await input.props.onChange({
      target: { files: [{ text: async () => '{"providers": "nope"}' }], value: 'x' },
    })
    await settle()
    assert.equal(harness.writes.length, 0, 'an invalid file must not touch the settings')
    assert.ok(
      textsOf(render()).some(text => text.includes('保存失败：') && text.includes('providers')),
      'the reason must be shown, and must not be a bare crash',
    )
  } finally {
    restore()
  }
})

test('N17: a cancelled restore writes nothing', async () => {
  const { mod, restore } = loadBundle()
  try {
    const harness = mountPlugin(mod)
    const [, render] = renderPage(mod, harness)
    await settle()
    globalThis.window = { ...globalThis.window, confirm: () => false }
    const input = findFirstNodeOfType(backupBlockOf(render()), 'input')
    await input.props.onChange({
      target: {
        files: [{ text: async () => JSON.stringify({ providers: { p: { enabled: true, host: 'h', port: 1 } } }) }],
        value: 'x',
      },
    })
    await settle()
    assert.equal(harness.writes.length, 0)
  } finally {
    restore()
  }
})

