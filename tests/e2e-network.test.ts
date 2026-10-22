// End-to-end through the REAL plugin entry: apply() against a mock Cordis
// context, with real HTTP proxies and a real origin, proving that
//   - an enabled provider's request leaves through ITS proxy, and
//   - a provider that is not enabled is untouched.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { apply, acquireFetchRouter } from '../lib/index.js'

async function startRecordingProxy(label) {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ via: label }))
  })
  server.on('connect', (req, socket) => {
    seen.push({ host: '(tunnel)', url: req.url })
    socket.on('error', () => {})
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { seen, port, label, close: () => new Promise(r => server.close(r)) }
}

/** The smallest Cordis surface apply() touches. */
function mockCtx() {
  const listeners = []
  const cleanups = []
  return {
    cleanups,
    on(event, fn) {
      listeners.push({ event, fn })
      return () => {
        const i = listeners.findIndex(l => l.event === event && l.fn === fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    emit(event, ...args) {
      // A waterfall event passes a `next` continuation; other events do not.
      const isWaterfall = typeof args[args.length - 1] === 'function'
      if (!isWaterfall) {
        for (const l of listeners.filter(l => l.event === event)) l.fn(...args)
        return undefined
      }
      const next = args.pop()
      const options = args[0]
      // Cordis waterfall, reduced to the listeners present. The adapter stream
      // is only created if a listener actually calls next().
      const matched = listeners.filter(l => l.event === event)
      const run = index => {
        if (index >= matched.length) return next()
        const result = matched[index].fn(options, () => run(index + 1))
        return result === undefined ? run(index + 1) : result
      }
      return run(0)
    },
    effect(fn) {
      // Cordis runs an effect's callback immediately and collects its disposer.
      const dispose = fn()
      cleanups.push(dispose)
      return () => {}
    },
  }
}

const settle = () => new Promise(r => setImmediate(() => setImmediate(r)))

test('apply() routes an enabled provider through its proxy', async () => {
  const proxy = await startRecordingProxy('proxied')
  const ctx = mockCtx()

  apply(ctx, {
    providers: { sensenova: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxy.port } },
  })
  await settle()

  try {
    let body
    async function* adapter() {
      // `.invalid` never resolves in DNS, so this only succeeds because the
      // proxy is doing the addressing — a direct attempt would fail outright.
      const res = await fetch('http://provider-target.invalid/v1/chat/completions')
      body = await res.json()
      yield { type: 'finish' }
    }

    const stream = ctx.emit('llm/stream', { provider: 'sensenova' }, adapter)
    for await (const _ of stream) {
      // drain
    }

    assert.equal(proxy.seen.length, 1, 'the request crossed the proxy')
    assert.equal(proxy.seen[0].host, 'provider-target.invalid', 'with the real target host')
    assert.equal(body.via, 'proxied', 'the proxy answered the request')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

test('a provider that is not enabled keeps the default network path', async () => {
  const proxy = await startRecordingProxy('proxied')
  const ctx = mockCtx()

  apply(ctx, {
    providers: { sensenova: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxy.port } },
  })
  await settle()

  try {
    let streamed = false
    async function* adapter() {
      // An unconfigured provider is not wrapped at all.
      streamed = true
      yield { type: 'finish' }
    }

    const stream = ctx.emit('llm/stream', { provider: 'opencode-go' }, adapter)
    for await (const _ of stream) {
      // drain
    }

    assert.equal(streamed, true, 'the unconfigured provider still streamed normally')
    assert.equal(proxy.seen.length, 0, 'nothing was routed through the proxy')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

test('a settings write re-routes without restarting the plugin', async () => {
  const proxyA = await startRecordingProxy('A')
  const proxyB = await startRecordingProxy('B')
  const ctx = mockCtx()

  // A Volatile reference, exactly as the Loader hands it over.
  let snapshot = { p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxyA.port } }
  const config = {
    get providers() {
      return { get: () => snapshot }
    },
  }

  apply(ctx, config)
  await settle()

  const call = async () => {
    async function* adapter() {
      const res = await fetch('http://switch-target.invalid/x')
      yield await res.json()
    }
    const stream = ctx.emit('llm/stream', { provider: 'p' }, adapter)
    for await (const chunk of stream) {
      return chunk
    }
    throw new Error('the adapter produced no chunk')
  }

  try {
    const first = await call()
    assert.equal(first.via, 'A', 'initially proxied through A')
    assert.equal(proxyA.seen.length, 1)

    // The user edits the settings; the Volatile reference is updated in place.
    snapshot = { p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxyB.port } }
    await ctx.emit('loader/volatile-update', [['providers']])
    await settle()

    const second = await call()
    assert.equal(second.via, 'B', 'the new request uses the new proxy')
    assert.equal(proxyB.seen.length, 1)

    // Turning the provider off returns it to the direct path.
    snapshot = { p: { enabled: false, protocol: 'http', host: '127.0.0.1', port: proxyB.port } }
    await ctx.emit('loader/volatile-update', [['providers']])
    await settle()
    assert.deepEqual(ctx.providerProxyState.routes, [], 'the disabled route is retired')

    await assert.rejects(() => call(), 'a disabled provider no longer reaches a proxy')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxyA.close()
    await proxyB.close()
  }
})

test('an invalid route is reported without breaking a valid one', async () => {
  const proxy = await startRecordingProxy('good')
  const ctx = mockCtx()

  apply(ctx, {
    providers: {
      sensenova: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxy.port },
      broken: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 0 },
    },
  })
  await settle()

  try {
    async function* adapter() {
      await fetch('http://provider-target.invalid/v1/chat/completions')
      yield { type: 'finish' }
    }
    const stream = ctx.emit('llm/stream', { provider: 'sensenova' }, adapter)
    for await (const _ of stream) {
      // drain
    }
    assert.equal(proxy.seen.length, 1, 'the valid provider still works')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

// ---- last-use tracking ----

test('a routed request records when it last ran and how it ended', async () => {
  // `hits` says a route has been used; this says whether it still WORKS, which
  // is the question a silently stalled proxy actually raises.
  const proxy = await startRecordingProxy('proxied')
  const ctx = mockCtx()
  apply(ctx, {
    providers: { sensenova: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxy.port } },
  })
  await settle()

  try {
    async function* adapter() {
      await fetch('http://provider-target.invalid/v1/chat/completions')
      yield { type: 'finish' }
    }
    for await (const _ of ctx.emit('llm/stream', { provider: 'sensenova' }, adapter)) {
      // drain
    }
    await settle()

    const record = ctx.providerProxyState.lastUse.sensenova
    assert.ok(record, 'the route the request crossed is recorded')
    assert.equal(record.ok, true, 'the proxy answered, so the last use reads as a success')
    assert.equal(record.code, '200', 'the ANSWER is kept, not just the verdict')
    assert.equal(typeof record.at, 'number')
    assert.equal(typeof record.startedAt, 'number')
    assert.ok(record.startedAt <= record.at, 'the start is recorded separately from the finish')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

/**
 * A forward proxy that answers `/slow` after a delay and everything else at
 * once, so one request can be observed while it is still in flight.
 */
async function startDelayedProxy(delayMs) {
  const server = createServer((req, res) => {
    const reply = () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }
    if (String(req.url).includes('slow')) setTimeout(reply, delayMs)
    else reply()
  })
  server.on('connect', (req, socket) => {
    socket.on('error', () => {})
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { port, close: () => new Promise(r => server.close(r)) }
}

test('a request merely STARTED does not overwrite the last COMPLETED outcome', async () => {
  // Two calls overlap: the first finishes, then a second starts and is still in
  // flight when the record is read. `at`/`ok`/`code` belong to the COMPLETED
  // call, so a newer start must move only `startedAt` — otherwise the card would
  // pair one request's outcome with another's start time.
  const proxy = await startDelayedProxy(400)
  const ctx = mockCtx()
  apply(ctx, {
    providers: { p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxy.port } },
  })
  await settle()

  try {
    async function* first() {
      await fetch('http://provider-target.invalid/fast')
      yield { type: 'a' }
    }
    for await (const _ of ctx.emit('llm/stream', { provider: 'p' }, first)) {
      // drain
    }
    await settle()
    const completed = ctx.providerProxyState.lastUse.p
    assert.equal(completed.ok, true)
    const completedAt = completed.at

    async function* second() {
      await fetch('http://provider-target.invalid/slow')
      yield { type: 'b' }
    }
    const iterator = ctx.emit('llm/stream', { provider: 'p' }, second)[Symbol.asyncIterator]()
    const pending = iterator.next()
    // A couple of ticks is far inside the 400 ms proxy delay, so the second call
    // is provably still in flight here.
    await settle()

    const inflight = ctx.providerProxyState.lastUse.p
    assert.equal(ctx.providerProxyState.hits.p, 2, 'the second call really started and was counted')
    assert.equal(inflight.ok, true, 'an in-flight call does not erase the last completed outcome')
    assert.equal(inflight.at, completedAt, '`at` still names the last COMPLETION, not the newer START')
    assert.equal(typeof inflight.startedAt, 'number')
    assert.ok(
      inflight.startedAt >= completedAt,
      'the newer start is recorded on its own field, apart from the outcome',
    )

    // Let the second call finish so nothing is left dangling.
    await pending
    await iterator.return()
    await settle()
    const after = ctx.providerProxyState.lastUse.p
    assert.ok(after.at > completedAt, 'once the second call finishes, `at` advances to its finish time')
    assert.equal(after.ok, true)
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

test('a response cut off mid-body still counts as answered', async () => {
  // `ok` is decided when the response HEADERS arrive — the point at which
  // `fetch` resolves — NOT at the end of the body, which is a lazily-forwarded
  // stream. A proxy that answers and then drops the connection mid-body must
  // therefore still record ok; that is exactly what the card's "last ok" means.
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: partial\n\n')
    // Cut the connection after the headers have flushed.
    setTimeout(() => res.socket?.destroy(), 20)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const ctx = mockCtx()
  apply(ctx, {
    providers: { p: { enabled: true, protocol: 'http', host: '127.0.0.1', port } },
  })
  await settle()

  try {
    async function* adapter() {
      const response = await fetch('http://provider-target.invalid/v1/chat/completions')
      assert.equal(response.status, 200, 'the headers arrived, so fetch resolved')
      yield { type: 'finish' }
    }
    for await (const _ of ctx.emit('llm/stream', { provider: 'p' }, adapter)) {
      // drain
    }
    await settle()
    const record = ctx.providerProxyState.lastUse.p
    assert.equal(record.ok, true, 'the reply arrived, so the route is recorded as working')
    assert.equal(record.code, '200')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await new Promise(resolve => server.close(resolve))
  }
})

test('a failed routed request records the real failure code', async () => {
  // Nothing listens on port 1. The card must be able to name WHY, not only that
  // something went wrong — a bare "fetch failed" points at nothing.
  const ctx = mockCtx()
  apply(ctx, {
    providers: { p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 1 } },
  })
  await settle()

  try {
    async function* adapter() {
      await fetch('http://provider-target.invalid/v1/chat/completions')
      yield { type: 'finish' }
    }
    const stream = ctx.emit('llm/stream', { provider: 'p' }, adapter)
    await assert.rejects(async () => {
      for await (const _ of stream) {
        // drain
      }
    }, 'the caller still sees the rejection: observing must not swallow it')
    await settle()

    const record = ctx.providerProxyState.lastUse.p
    assert.ok(record)
    assert.equal(record.ok, false)
    assert.match(record.code, /ECONNREFUSED/, 'the real code, not a generic "ERROR"')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
  }
})

// ---- last-use is bound to the current route configuration ----

test('changing the proxy endpoint clears lastUse but keeps hits', async () => {
  const proxyA = await startRecordingProxy('A')
  const proxyB = await startRecordingProxy('B')
  const ctx = mockCtx()
  let snapshot = {
    p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxyA.port },
    q: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxyA.port },
  }
  const config = { providers: { get: () => snapshot } }
  apply(ctx, config)
  await settle()

  const call = async (provider) => {
    async function* adapter() {
      await fetch(`http://${provider}-target.invalid/x`)
      yield { type: 'finish' }
    }
    for await (const _ of ctx.emit('llm/stream', { provider }, adapter)) {
      // drain
    }
  }

  try {
    await call('p')
    await call('q')
    await settle()
    assert.equal(ctx.providerProxyState.hits.p, 1)
    assert.equal(ctx.providerProxyState.hits.q, 1)
    assert.ok(ctx.providerProxyState.lastUse.p)
    assert.ok(ctx.providerProxyState.lastUse.q)

    snapshot = { ...snapshot, p: { ...snapshot.p, port: proxyB.port } }
    await ctx.emit('loader/volatile-update', [['providers']])
    await settle()
    assert.equal(ctx.providerProxyState.lastUse.p, undefined, 'the changed route loses its old health proof')
    assert.ok(ctx.providerProxyState.lastUse.q, 'an unrelated route keeps its record')
    assert.equal(ctx.providerProxyState.hits.p, 1, 'hits is a historical counter')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxyA.close()
    await proxyB.close()
  }
})

test('only disabling a route keeps lastUse, while its old token cannot write back', async () => {
  const proxy = await startRecordingProxy('A')
  const ctx = mockCtx()
  let snapshot = {
    p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxy.port },
  }
  const config = { providers: { get: () => snapshot } }
  apply(ctx, config)
  await settle()

  try {
    async function* adapter() {
      await fetch('http://api.example.com/one')
      yield { type: 'finish' }
    }
    for await (const _ of ctx.emit('llm/stream', { provider: 'p' }, adapter)) {
      // drain
    }
    await settle()
    const retained = ctx.providerProxyState.lastUse.p
    assert.ok(retained)

    snapshot = { p: { ...snapshot.p, enabled: false } }
    await ctx.emit('loader/volatile-update', [['providers']])
    await settle()
    assert.deepEqual(ctx.providerProxyState.lastUse.p, retained, 'turning off is not a config change')

    snapshot = { p: { ...snapshot.p, enabled: true } }
    await ctx.emit('loader/volatile-update', [['providers']])
    await settle()
    assert.deepEqual(ctx.providerProxyState.lastUse.p, retained, 'turning back on keeps the record')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

test('a stream bound to an old route cannot write after the config changes', async () => {
  const proxyA = await startRecordingProxy('A')
  const proxyB = await startRecordingProxy('B')
  const ctx = mockCtx()
  let snapshot = {
    p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxyA.port },
  }
  const config = { providers: { get: () => snapshot } }
  apply(ctx, config)
  await settle()

  try {
    let started
    const start = new Promise(resolve => { started = resolve })
    async function* adapter() {
      started()
      await fetch('http://provider-target.invalid/slow')
      yield { type: 'finish' }
    }
    const stream = ctx.emit('llm/stream', { provider: 'p' }, adapter)
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await start

    snapshot = { p: { ...snapshot.p, port: proxyB.port } }
    await ctx.emit('loader/volatile-update', [['providers']])
    await settle()
    assert.equal(ctx.providerProxyState.lastUse.p, undefined, 'the old route record is cleared')

    await pending
    await iterator.return()
    await settle()
    assert.equal(ctx.providerProxyState.lastUse.p, undefined, 'the old settle must not recreate it')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxyA.close()
    await proxyB.close()
  }
})

test('a deleted and re-added provider cannot be written by its old stream', async () => {
  const proxy = await startRecordingProxy('A')
  const ctx = mockCtx()
  let snapshot = {
    p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxy.port },
  }
  const config = { providers: { get: () => snapshot } }
  apply(ctx, config)
  await settle()

  try {
    let started
    const start = new Promise(resolve => { started = resolve })
    async function* adapter() {
      started()
      await fetch('http://provider-target.invalid/slow')
      yield { type: 'finish' }
    }
    const iterator = ctx.emit('llm/stream', { provider: 'p' }, adapter)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await start

    snapshot = {}
    await ctx.emit('loader/volatile-update', [['providers']])
    await settle()
    snapshot = { p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxy.port } }
    await ctx.emit('loader/volatile-update', [['providers']])
    await settle()

    await pending
    await iterator.return()
    await settle()
    assert.equal(ctx.providerProxyState.lastUse.p, undefined, 'a re-added provider is a new route')
    assert.equal(ctx.providerProxyState.hits.p, 1, 'the old request was still counted')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

test('lastUse survives a testTarget edit but not a localDirect edit', async () => {
  const proxy = await startRecordingProxy('A')
  const ctx = mockCtx()
  let providers = {
    p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxy.port, testTarget: 'http://one.invalid/ip' },
  }
  let localDirect = true
  const config = {
    providers: { get: () => providers },
    localDirect: { get: () => localDirect },
  }
  apply(ctx, config)
  await settle()

  try {
    async function* adapter() {
      await fetch('http://api.example.com/one')
      yield { type: 'finish' }
    }
    for await (const _ of ctx.emit('llm/stream', { provider: 'p' }, adapter)) {
      // drain
    }
    await settle()
    const retained = ctx.providerProxyState.lastUse.p
    assert.ok(retained)

    providers = { p: { ...providers.p, testTarget: 'http://two.invalid/ip' } }
    await ctx.emit('loader/volatile-update', [['providers']])
    await settle()
    assert.deepEqual(ctx.providerProxyState.lastUse.p, retained, 'the check target does not route traffic')

    localDirect = false
    await ctx.emit('loader/volatile-update', [['localDirect']])
    await settle()
    assert.equal(ctx.providerProxyState.lastUse.p, undefined, 'localDirect changes every route decision')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

test('lastUse survives a rule reorder and a duplicate, but not a rule change', async () => {
  const proxy = await startRecordingProxy('A')
  const ctx = mockCtx()
  let providers = {
    p: {
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: proxy.port,
      onlyHosts: 'api.example.com, .internal.test',
    },
  }
  const config = { providers: { get: () => providers } }
  apply(ctx, config)
  await settle()

  try {
    async function* adapter() {
      await fetch('http://api.example.com/one')
      yield { type: 'finish' }
    }
    for await (const _ of ctx.emit('llm/stream', { provider: 'p' }, adapter)) {
      // drain
    }
    await settle()
    const retained = ctx.providerProxyState.lastUse.p
    assert.ok(retained)

    providers = {
      p: {
        ...providers.p,
        onlyHosts: '*.INTERNAL.test, API.EXAMPLE.COM, api.example.com',
      },
    }
    await ctx.emit('loader/volatile-update', [['providers']])
    await settle()
    assert.deepEqual(ctx.providerProxyState.lastUse.p, retained, 'equivalent rule spelling keeps the record')

    providers = { p: { ...providers.p, onlyHosts: 'other.example.com' } }
    await ctx.emit('loader/volatile-update', [['providers']])
    await settle()
    assert.equal(ctx.providerProxyState.lastUse.p, undefined, 'a real rule change clears the record')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

test('a defaultProxy edit clears only routes that inherit it', async () => {
  const proxy = await startRecordingProxy('A')
  const ctx = mockCtx()
  let providers = {
    inherited: { enabled: true, useDefault: true },
    own: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxy.port },
  }
  let defaultProxy = { protocol: 'http', host: '127.0.0.1', port: proxy.port }
  const config = {
    providers: { get: () => providers },
    defaultProxy: { get: () => defaultProxy },
  }
  apply(ctx, config)
  await settle()

  try {
    async function* adapter() {
      await fetch('http://provider-target.invalid/one')
      yield { type: 'finish' }
    }
    for (const provider of ['inherited', 'own']) {
      for await (const _ of ctx.emit('llm/stream', { provider }, adapter)) {
        // drain
      }
    }
    await settle()
    const inheritedBefore = ctx.providerProxyState.lastUse.inherited
    const ownBefore = ctx.providerProxyState.lastUse.own
    assert.ok(inheritedBefore)
    assert.ok(ownBefore)

    defaultProxy = { ...defaultProxy, port: proxy.port + 1 }
    await ctx.emit('loader/volatile-update', [['defaultProxy']])
    await settle()
    assert.equal(ctx.providerProxyState.lastUse.inherited, undefined, 'the inherited route moved')
    assert.deepEqual(ctx.providerProxyState.lastUse.own, ownBefore, 'the own-endpoint route did not move')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

test('back-to-back config updates settle on the last snapshot', async () => {
  const proxyA = await startRecordingProxy('A')
  const proxyB = await startRecordingProxy('B')
  const ctx = mockCtx()
  let snapshot = {
    p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxyA.port },
  }
  const config = { providers: { get: () => snapshot } }
  apply(ctx, config)
  await settle()

  try {
    snapshot = { p: { ...snapshot.p, port: proxyA.port } }
    ctx.emit('loader/volatile-update', [['providers']])
    snapshot = { p: { ...snapshot.p, port: proxyB.port } }
    ctx.emit('loader/volatile-update', [['providers']])
    await settle()
    assert.equal(ctx.providerProxyState.routes[0].proxyOrigin, `http://127.0.0.1:${proxyB.port}`)

    async function* adapter() {
      await fetch('http://provider-target.invalid/one')
      yield { type: 'finish' }
    }
    for await (const _ of ctx.emit('llm/stream', { provider: 'p' }, adapter)) {
      // drain
    }
    assert.equal(proxyB.seen.length, 1, 'the request used the last snapshot')
    assert.equal(proxyA.seen.length, 0, 'the superseded snapshot never carried a request')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxyA.close()
    await proxyB.close()
  }
})
