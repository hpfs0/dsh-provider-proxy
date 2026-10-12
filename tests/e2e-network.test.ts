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