import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { acquireFetchRouter } from '../lib/index.js'
import { ProxyAgent } from 'undici'

/**
 * A real HTTP forward proxy that records the absolute-form request line it
 * receives. Using a real proxy (rather than a stubbed fetch) is what makes
 * these tests meaningful: it proves the request genuinely leaves through the
 * proxy, and it exercises the same undici realm the plugin ships.
 */
async function startRecordingProxy() {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ via: 'proxy' }))
  })
  server.on('connect', (req, socket) => {
    seen.push({ url: req.url, host: '(tunnel)' })
    socket.on('error', () => {})
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    seen,
    port,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/**
 * The regression this guards: an adapter consumes its stream lazily, so the
 * HTTP call happens inside a LATER next(), after als.run() already returned.
 * Without re-applying the scope to every iterator step, every request would
 * silently go direct.
 */
test('the scope survives lazy consumption of the stream', async () => {
  const proxy = await startRecordingProxy()
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })

  try {
    async function* lazyAdapter() {
      await new Promise(resolve => setImmediate(resolve))
      await fetch('http://lazy-target.invalid/v1/messages')
      yield { type: 'finish' }
    }

    const chunks = []
    // Consumed well outside any run() scope, exactly as a real adapter is.
    for await (const chunk of router.wrap(agent, lazyAdapter)) chunks.push(chunk)

    assert.equal(chunks.length, 1)
    assert.equal(proxy.seen.length, 1, 'the lazy request crossed the proxy')
    assert.equal(proxy.seen[0].host, 'lazy-target.invalid', 'the proxy saw the real target host')
  } finally {
    await agent.close()
    router.release()
    await proxy.close()
  }
})

test('no scope means the default network path is used', async () => {
  const proxy = await startRecordingProxy()
  const router = acquireFetchRouter()

  try {
    // Unreachable host, no scope: fails directly rather than via the proxy.
    await assert.rejects(() => fetch('http://127.0.0.1:1/direct'))
    assert.equal(proxy.seen.length, 0, 'nothing crossed the proxy')
  } finally {
    router.release()
    await proxy.close()
  }
})

test('two providers never share a dispatcher', async () => {
  const proxyA = await startRecordingProxy()
  const proxyB = await startRecordingProxy()
  const router = acquireFetchRouter()
  const a = new ProxyAgent({ uri: `http://127.0.0.1:${proxyA.port}` })
  const b = new ProxyAgent({ uri: `http://127.0.0.1:${proxyB.port}` })

  try {
    async function* adapter(label) {
      await new Promise(resolve => setImmediate(resolve))
      await fetch(`http://${label}.invalid/x`)
      yield 1
    }

    const drain = async stream => {
      for await (const _ of stream) {
        // the adapter issues the fetch while suspended
      }
    }

    // Two providers, interleaved, each with a DIFFERENT proxy.
    await Promise.all([drain(router.wrap(a, () => adapter('alpha'))), drain(router.wrap(b, () => adapter('beta')))])

    assert.deepEqual(proxyA.seen.map(s => s.host), ['alpha.invalid'], 'proxy A only saw provider A')
    assert.deepEqual(proxyB.seen.map(s => s.host), ['beta.invalid'], 'proxy B only saw provider B')
  } finally {
    await a.close()
    await b.close()
    router.release()
    await proxyA.close()
    await proxyB.close()
  }
})

test('two providers sharing one address still keep separate dispatchers', async () => {
  const proxy = await startRecordingProxy()
  const router = acquireFetchRouter()
  // Same proxy address, two distinct dispatcher instances.
  const a = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })
  const b = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })
  assert.notEqual(a, b)

  try {
    async function* adapter(label) {
      await new Promise(resolve => setImmediate(resolve))
      await fetch(`http://${label}.invalid/x`)
      yield 1
    }
    const drain = async stream => {
      for await (const _ of stream) {}
    }
    await Promise.all([drain(router.wrap(a, () => adapter('one'))), drain(router.wrap(b, () => adapter('two')))])

    assert.deepEqual(proxy.seen.map(s => s.host).sort(), ['one.invalid', 'two.invalid'])
  } finally {
    await a.close()
    await b.close()
    router.release()
    await proxy.close()
  }
})

test('return() before the first next() never touches the adapter', async () => {
  const router = acquireFetchRouter()
  let constructed = false
  const stream = router.wrap({ close: async () => {} }, () => {
    constructed = true
    return (async function* () {
      yield 1
    })()
  })

  const result = await stream[Symbol.asyncIterator]().return('done')
  assert.equal(result.done, true)
  assert.equal(constructed, false, 'an abandoned stream must not start the adapter')
  router.release()
})

test('releasing the last holder restores the original fetch', () => {
  const before = globalThis.fetch
  const router = acquireFetchRouter()
  assert.notEqual(globalThis.fetch, before, 'the shim is installed')
  router.release()
  assert.equal(globalThis.fetch, before, 'the original fetch is restored')
})

test('two holders share one shim and restore it only once both release', () => {
  const before = globalThis.fetch
  const first = acquireFetchRouter()
  const second = acquireFetchRouter()
  first.release()
  assert.notEqual(globalThis.fetch, before, 'still held by the second holder')
  second.release()
  assert.equal(globalThis.fetch, before)
})