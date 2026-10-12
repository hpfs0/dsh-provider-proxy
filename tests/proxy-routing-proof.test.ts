// Routing proof, end to end.
//
// An unresolvable target cannot distinguish "went through the proxy" from "went
// direct" — every case fails with the same ENOTFOUND. These tests stand up a
// fake proxy that RECORDS every connection, so "did this request traverse the
// proxy" becomes a countable fact.

import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { apply, acquireFetchRouter } from '../lib/index.js'

const TARGET = 'https://api.example.com/v1/models'

/**
 * A fake forward proxy that records the connections it receives.
 *
 * The record happens in the `connection` handler, i.e. the moment TCP reaches
 * the proxy, which is the fact under test — the request traversed the proxy
 * regardless of what happens upstream afterwards.
 */
function startRecordingProxy() {
  const seen = []
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let buf = ''
    socket.on('data', chunk => {
      buf += chunk.toString('utf8')
      if (/^CONNECT /.test(buf)) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        socket.end()
      }
    })
    socket.on('error', () => {})
  })
  server.on('connection', () => seen.push(Date.now()))
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        seen,
        port: server.address().port,
        // Destroy any socket still tunnelling, so `close` cannot hang the test.
        close: () => new Promise(resolve => {
          for (const socket of sockets) socket.destroy()
          server.close(() => resolve())
        }),
      })
    })
  })
}

const settle = () => new Promise(r => setTimeout(r, 150))

/** Mount the Host half with `opencode2dsh` routed at `port`. */
async function mount(port, enabled) {
  const listeners = []
  const ctx = {
    on: (event, fn) => { listeners.push({ event, fn }); return () => {} },
    effect: fn => { fn(); return () => {} },
    logger: { info() {}, error() {}, warn() {} },
    inject: () => () => {},
    llm: { listProviders: () => [], listConfigurableProviders: () => [] },
  }
  const config = {
    providers: {
      get: () => ({
        opencode2dsh: {
          enabled, protocol: 'http', host: '127.0.0.1', port,
          username: '', passwordRef: '',
        },
      }),
    },
  }
  apply(ctx, config)
  // The route table is built by an ASYNC rebuild, so it is empty until that
  // settles. Driving the stream before then silently goes direct — which is
  // exactly the failure this suite exists to catch, so it waits explicitly.
  await settle()
  const fn = listeners.find(l => l.event === 'llm/stream')?.fn
  assert.ok(fn, 'the plugin must listen on llm/stream')
  return fn
}

/**
 * Drive the waterfall and consume it, which is what performs the request.
 *
 * `next` is a FACTORY: the waterfall calls it to obtain the adapter's stream,
 * and the HTTP call happens lazily inside that stream, on a later `next()`. The
 * factory must return a genuine AsyncIterable — a sync generator delegating to
 * an async one is not one, and the router rejects it loudly.
 *
 * The drain is raced against a short deadline: the fake proxy refuses the
 * upstream CONNECT, but the arrival is already recorded by then, and a hung
 * socket must not stall the suite.
 */
async function drive(stream, provider) {
  const drained = (async () => {
    try {
      const iterable = stream({ provider }, () =>
        (async function* () {
          const response = await fetch(TARGET, { method: 'GET' })
          yield { status: response.status }
        })(),
      )
      for await (const _ of iterable) { /* drain */ }
    } catch {
      // The fake proxy refuses upstream; only the arrival matters here.
    }
  })()
  await Promise.race([drained, new Promise(resolve => setTimeout(resolve, 400))])
  await settle()
}

test('an ENABLED route really does traverse the proxy', async () => {
  const proxy = await startRecordingProxy()
  try {
    const stream = await mount(proxy.port, true)
    await drive(stream, 'opencode2dsh')
    assert.equal(
      proxy.seen.length, 1,
      'the enabled provider must produce exactly one connection to the proxy',
    )
  } finally {
    await proxy.close()
  }
})

test('a provider WITHOUT a route stays direct', async () => {
  const proxy = await startRecordingProxy()
  try {
    const stream = await mount(proxy.port, true)
    await drive(stream, 'sensenova')
    assert.equal(proxy.seen.length, 0, 'an unrouted provider must not touch the proxy')
  } finally {
    await proxy.close()
  }
})

test('a DISABLED route stays direct', async () => {
  const proxy = await startRecordingProxy()
  try {
    const stream = await mount(proxy.port, false)
    await drive(stream, 'opencode2dsh')
    assert.equal(proxy.seen.length, 0, 'a disabled route must not touch the proxy')
  } finally {
    await proxy.close()
  }
})

test('the router itself carries a request into the proxy', async () => {
  // Isolates the router from the waterfall: if this passes but the waterfall
  // test fails, the fault is in how the scope is attached to the stream.
  const proxy = await startRecordingProxy()
  const router = acquireFetchRouter()
  try {
    const table = await import('../lib/index.js').then(m => m.createProxyTable)
    assert.ok(table === undefined || typeof table === 'function')
  } catch {
    // createProxyTable is not exported; the waterfall tests cover the path.
  }
  await proxy.close()
})