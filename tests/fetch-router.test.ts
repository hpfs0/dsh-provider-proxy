import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import { acquireFetchRouter, apply } from '../lib/index.js'
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
    for await (const chunk of router.wrap({ dispatcher: agent }, lazyAdapter)) chunks.push(chunk)

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
    await Promise.all([
      drain(router.wrap({ dispatcher: a }, () => adapter('alpha'))),
      drain(router.wrap({ dispatcher: b }, () => adapter('beta'))),
    ])

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
    await Promise.all([
      drain(router.wrap({ dispatcher: a }, () => adapter('one'))),
      drain(router.wrap({ dispatcher: b }, () => adapter('two'))),
    ])

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
  const stream = router.wrap({ dispatcher: { close: async () => {} } }, () => {
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

test('onHit fires once per request that crosses the proxy', async () => {
  const proxy = await startRecordingProxy()
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })
  let hits = 0

  try {
    const stream = router.wrap(
      { dispatcher: agent, onHit: () => { hits += 1 } },
      () => (async function* () {
        await new Promise(resolve => setImmediate(resolve))
        await fetch('http://counted.invalid/x')
        yield 1
      })(),
    )
    for await (const _ of stream) {
      // consume
    }
    assert.equal(hits, 1, 'the routed request was counted exactly once')
    assert.equal(proxy.seen.length, 1)
  } finally {
    await agent.close()
    router.release()
    await proxy.close()
  }
})

test('a direct verdict from decide keeps the native path and is not counted', async () => {
  const proxy = await startRecordingProxy()
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })
  let seenHost: string | undefined
  let hits = 0

  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        onHit: () => { hits += 1 },
        decide: host => { seenHost = host; return 'direct' },
      },
      () => (async function* () {
        await new Promise(resolve => setImmediate(resolve))
        // Unreachable: a `direct` verdict means this never crosses the proxy.
        await fetch('http://127.0.0.1:1/bypassed')
        yield 1
      })(),
    )
    await assert.rejects(async () => {
      for await (const _ of stream) {
        // the request fails directly, without the proxy
      }
    })
    assert.equal(seenHost, '127.0.0.1', 'decide saw the target host')
    assert.equal(proxy.seen.length, 0, 'a direct verdict must not cross the proxy')
    assert.equal(hits, 0, 'a direct request is not a hit')
  } finally {
    await agent.close()
    router.release()
    await proxy.close()
  }
})

test('decide sees undefined for a target it cannot parse', async () => {
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: 'http://127.0.0.1:1' })
  let called = false
  let seenHost: string | undefined = 'unset'

  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        decide: host => { called = true; seenHost = host; return 'direct' },
      },
      () => (async function* () {
        // `new URL('/relative/path')` THROWS, so requestHost must swallow it and
        // hand the rule an undefined host rather than letting the throw escape.
        await fetch('/relative/path')
        yield 1
      })(),
    )
    await assert.rejects(async () => {
      for await (const _ of stream) {
        // the native fetch rejects on a relative URL
      }
    })
    assert.equal(called, true, 'decide must still run')
    assert.equal(seenHost, undefined, 'an unparsable target reaches decide as undefined')
  } finally {
    await agent.close()
    router.release()
  }
})

test('decide is told which traffic type the scope carries (N24)', async () => {
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: 'http://127.0.0.1:1' })
  const calls: Array<{ host: string | undefined; type: unknown }> = []

  const decide = (host: string | undefined, context: { trafficType?: unknown }) => {
    calls.push({ host, type: context.trafficType })
    return 'direct' as const
  }

  try {
    // A search scope and a reasoning scope, each carrying its own label.
    for (const trafficType of ['search', 'reasoning'] as const) {
      const stream = router.wrap(
        { dispatcher: agent, trafficType, decide },
        () => (async function* () {
          await fetch('http://127.0.0.1:1/labelled')
          yield 1
        })(),
      )
      await assert.rejects(async () => {
        for await (const _ of stream) {
          // the verdict is `direct`, so this fails on the loopback target
        }
      })
    }
    assert.deepEqual(
      calls.map(call => call.type),
      ['search', 'reasoning'],
      'the rule can tell the two traffic types apart without a second router',
    )

    // A scope that does not say stays undefined rather than being guessed.
    const unlabelled = router.wrap(
      { dispatcher: agent, decide },
      () => (async function* () {
        await fetch('http://127.0.0.1:1/labelled')
        yield 1
      })(),
    )
    await assert.rejects(async () => {
      for await (const _ of unlabelled) {
        // same direct verdict
      }
    })
    assert.equal(calls.at(-1)?.type, undefined)
  } finally {
    await agent.close()
    router.release()
  }
})

// ---- P2-11: a stream outliving a settings rebuild keeps its dispatcher ----

/**
 * The release hook is what lets a settings write retire an old dispatcher safely.
 *
 * It must fire at the FIRST request (undici keeps that request alive by itself)
 * and, for a stream that never issues one, when the stream ends — otherwise a
 * retired dispatcher would either be closed too early or never be closed at all.
 * The callback below mirrors the idempotence the Host relies on.
 */
test('P2-11: the release hook fires when the request starts, and once only', async () => {
  const proxy = await startRecordingProxy()
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })
  let released = false
  let releases = 0
  const release = () => {
    if (released) return
    released = true
    releases += 1
  }

  try {
    const stream = router.wrap(
      { dispatcher: agent, onLeaseRelease: release },
      () => (async function* () {
        await new Promise(resolve => setImmediate(resolve))
        await fetch('http://leased.invalid/x')
        yield 1
      })(),
    )
    assert.equal(releases, 0, 'nothing has been sent yet, so the claim still holds')

    const iterator = stream[Symbol.asyncIterator]()
    const first = await iterator.next()
    assert.equal(first.done, false)
    assert.equal(releases, 1, 'the claim is released as soon as the request starts')

    await iterator.next()
    assert.equal(releases, 1, 'a duplicate release at the end is absorbed')
  } finally {
    await agent.close()
    router.release()
    await proxy.close()
  }
})

test('P2-11: a stream that never issues a request releases its claim when it ends', async () => {
  const router = acquireFetchRouter()
  let releases = 0

  try {
    const stream = router.wrap(
      { dispatcher: { close: async () => {} }, onLeaseRelease: () => { releases += 1 } },
      () => (async function* () {
        yield 1
      })(),
    )
    for await (const _ of stream) {
      // completes without a fetch
    }
    assert.equal(releases, 1, 'the claim is released at the end of the stream')

    // Abandoning a stream before its first next() must release it too: the
    // adapter never runs, so nothing else could ever release it.
    const abandoned = router.wrap(
      { dispatcher: { close: async () => {} }, onLeaseRelease: () => { releases += 1 } },
      () => (async function* () {
        yield 1
      })(),
    )
    const result = await abandoned[Symbol.asyncIterator]().return('done')
    assert.equal(result.done, true)
    assert.equal(releases, 2, 'an abandoned stream releases when it is closed')
  } finally {
    router.release()
  }
})

/**
 * The end-to-end case from the defect report: a stream is created, a settings
 * write rebuilds the table (which RETIRES the previous generation), and only then
 * is the stream consumed. Its request must still succeed on the dispatcher it was
 * created with — the rebuild must not have closed it underneath.
 */
test('P2-11: a stream created before a settings rebuild still completes', async () => {
  const proxyA = await startRecordingProxy()
  const proxyB = await startRecordingProxy()

  const listeners: { event: string; fn: Function }[] = []
  const mockCtx: any = {
    on(event: string, fn: Function) {
      listeners.push({ event, fn })
      return () => {}
    },
    emit() {},
    effect(fn: Function) {
      return fn()
    },
    logger: { info() {}, error() {}, warn() {} },
    llm: { listProviders: () => [{ id: 'p', name: 'P' }] },
  }

  let providers = {
    p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxyA.port },
  }
  const config = { providers: { get: () => providers } }

  try {
    apply(mockCtx, config)
    const streamListener = listeners.find(listener => listener.event === 'llm/stream')
    assert.ok(streamListener, 'llm/stream listener registered')

    const stream = streamListener.fn(
      { provider: 'p' },
      () =>
        (async function* () {
          // The adapter issues its HTTP call here, long after the rebuild below.
          await new Promise(resolve => setImmediate(resolve))
          const res = await fetch('http://kept.invalid/v1/messages')
          yield await res.json()
        })(),
    )

    // A settings write lands and the Host rebuilds its whole table.
    providers = {
      p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxyB.port },
    }
    const volatileListener = listeners.find(listener => listener.event === 'loader/volatile-update')
    assert.ok(volatileListener, 'the rebuild hook is registered')
    volatileListener.fn()
    await new Promise(resolve => setImmediate(resolve))

    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)

    assert.deepEqual(chunks, [{ via: 'proxy' }], 'the stream completes instead of failing')
    assert.equal(proxyA.seen.length, 1, 'the request crossed the proxy the stream was created on')
    assert.equal(proxyB.seen.length, 0, 'and not the one the rebuild installed')
  } finally {
    await proxyA.close()
    await proxyB.close()
  }
})