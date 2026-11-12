import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { Readable } from 'node:stream'
import { ProxyAgent } from 'undici'

import {
  acquireFetchRouter,
  apply,
  canReplayRequest,
  kNativeFetch,
  isNetworkFailoverError,
} from '../lib/index.js'

async function startOriginServer() {
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ origin: true, hits }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    port,
    url: `http://127.0.0.1:${port}/target`,
    getHits: () => hits,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function getUnusedPort(): Promise<number> {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  await new Promise(resolve => server.close(resolve))
  return port
}

/** Drain a stream and return the error it failed with (fails if it succeeds). */
async function rejectionOf(stream: AsyncIterable<unknown>): Promise<unknown> {
  try {
    for await (const _ of stream) {
      // every new P1-4 case is expected to fail
    }
  } catch (error) {
    return error
  }
  throw new Error('expected the stream to reject')
}

/** Every `code` in an error's cause chain, so a test can pin the failure it caused. */
function errorCodes(error: unknown): string[] {
  const codes = []
  for (let node = error; node !== null && typeof node === 'object'; node = (node as any).cause) {
    const code = (node as any).code
    if (typeof code === 'string') codes.push(code)
  }
  return codes
}

/**
 * A proxy that accepts the TCP connection and then sends a RST.
 *
 * This is the case the old classifier got wrong: a connection DID exist, so the
 * request (and its body) may already have reached the far side. Re-sending it
 * through the native path is how one POST runs twice.
 */
async function startResettingProxy() {
  const seen = []
  const server = createTcpServer(socket => {
    socket.on('error', () => {})
    socket.once('data', chunk => {
      seen.push(String(chunk))
      socket.resetAndDestroy()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    seen,
    port,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/** A proxy that accepts the connection and then stays silent forever. */
async function startSilentProxy() {
  const sockets = new Set()
  const server = createTcpServer(socket => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.on('data', () => {
      // Deliberately never answers: the caller's own timeout is what fires.
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    port,
    close: () =>
      new Promise(resolve => {
        for (const socket of sockets) socket.destroy()
        server.close(resolve)
      }),
  }
}

test('P1-4: only connection-establishment failures authorise a fallback', () => {
  assert.equal(isNetworkFailoverError(null), false)
  assert.equal(isNetworkFailoverError(undefined), false)
  assert.equal(isNetworkFailoverError(new Error('ordinary error')), false)

  // Before the connection ever exists: nothing can have reached the upstream.
  assert.equal(isNetworkFailoverError({ code: 'ECONNREFUSED' }), true)
  assert.equal(isNetworkFailoverError({ code: 'ETIMEDOUT' }), true)
  assert.equal(isNetworkFailoverError({ code: 'EHOSTUNREACH' }), true)
  assert.equal(isNetworkFailoverError({ code: 'ENETUNREACH' }), true)
  assert.equal(isNetworkFailoverError({ name: 'ConnectTimeoutError' }), true)

  // After the connection existed: the request may have been executed upstream.
  assert.equal(
    isNetworkFailoverError({ code: 'ECONNRESET' }),
    false,
    'a reset means the peer had a connection, so the request may already have run',
  )
  assert.equal(
    isNetworkFailoverError({ name: 'TimeoutError' }),
    false,
    "the caller's AbortSignal.timeout says nothing about whether the request left",
  )
  assert.equal(isNetworkFailoverError({ name: 'TimeoutError', code: 'UND_ERR_ABORTED' }), false)
  assert.equal(
    isNetworkFailoverError({ name: 'HeadersTimeoutError', code: 'UND_ERR_HEADERS_TIMEOUT' }),
    false,
  )
  assert.equal(
    isNetworkFailoverError({ name: 'BodyTimeoutError', code: 'UND_ERR_BODY_TIMEOUT' }),
    false,
  )

  const wrapped = new TypeError('fetch failed')
  ;(wrapped as any).cause = { code: 'ECONNREFUSED' }
  assert.equal(isNetworkFailoverError(wrapped), true)
})

test('P1-4: a streamed body is never replayed', () => {
  assert.equal(canReplayRequest('http://x.invalid', undefined), true)
  assert.equal(canReplayRequest('http://x.invalid', { body: 'payload' }), true)
  assert.equal(canReplayRequest('http://x.invalid', { body: new Uint8Array([1, 2]) }), true)
  assert.equal(canReplayRequest('http://x.invalid', { body: new URLSearchParams({ a: '1' }) }), true)
  // A stream is consumed by the first attempt: a retry would throw TypeError and
  // hide the real proxy error.
  assert.equal(canReplayRequest('http://x.invalid', { body: Readable.from(['x']) }), false)
  assert.equal(
    canReplayRequest('http://x.invalid', { body: new ReadableStream({ start() {} }) }),
    false,
  )
  // A Request carries its own body: only an empty one can be sent again.
  assert.equal(canReplayRequest(new Request('http://x.invalid'), undefined), true)
  assert.equal(
    canReplayRequest(new Request('http://x.invalid', { method: 'POST', body: 'x' }), undefined),
    false,
  )
})

test('N18: when enableFallbackDirect is true, dead proxy triggers automatic fallback to native direct fetch', async () => {
  const origin = await startOriginServer()
  const deadPort = await getUnusedPort()
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort}` })

  let onHitCalled = false
  let onFallbackCalled = false
  let settledOk: boolean | undefined
  let settledFallback: boolean | undefined

  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        enableFallbackDirect: true,
        onHit: () => {
          onHitCalled = true
        },
        onFallback: () => {
          onFallbackCalled = true
        },
        onSettle: (ok, _detail, meta) => {
          settledOk = ok
          settledFallback = meta?.fallback
        },
      },
      () =>
        (async function* () {
          await new Promise(resolve => setImmediate(resolve))
          const res = await fetch(origin.url)
          const body = (await res.json()) as { origin: boolean }
          yield body
        })(),
    )

    const results = []
    for await (const chunk of stream) {
      results.push(chunk)
    }

    assert.equal(results.length, 1)
    assert.equal((results[0] as any).origin, true)
    assert.equal(onHitCalled, true, 'onHit was fired')
    assert.equal(onFallbackCalled, true, 'onFallback was triggered')
    assert.equal(settledOk, true, 'settled as ok')
    assert.equal(settledFallback, true, 'settled with fallback: true')
    assert.equal(origin.getHits(), 1, 'request arrived at origin')
  } finally {
    await agent.close()
    router.release()
    await origin.close()
  }
})

test('N18: when enableFallbackDirect is false (default), dead proxy strictly fails closed', async () => {
  const origin = await startOriginServer()
  const deadPort = await getUnusedPort()
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort}` })

  let onFallbackCalled = false
  let settledOk: boolean | undefined

  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        enableFallbackDirect: false,
        onFallback: () => {
          onFallbackCalled = true
        },
        onSettle: ok => {
          settledOk = ok
        },
      },
      () =>
        (async function* () {
          await new Promise(resolve => setImmediate(resolve))
          await fetch(origin.url)
          yield 1
        })(),
    )

    await assert.rejects(async () => {
      for await (const _ of stream) {
        // should throw
      }
    })

    assert.equal(onFallbackCalled, false, 'onFallback must NOT trigger when disabled')
    assert.equal(settledOk, false, 'settled as not ok')
    assert.equal(origin.getHits(), 0, 'request must NOT reach origin')
  } finally {
    await agent.close()
    router.release()
    await origin.close()
  }
})

test('N18: apply() e2e records fallback alarm in lastUse and preserves response', async () => {
  const origin = await startOriginServer()
  const deadPort = await getUnusedPort()

  const listeners: { event: string; fn: Function }[] = []
  const mockCtx: any = {
    on(event: string, fn: Function) {
      listeners.push({ event, fn })
      return () => {
        const i = listeners.findIndex(l => l.event === event && l.fn === fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    emit() {},
    effect(fn: Function) {
      return fn()
    },
    llm: {
      listProviders: () => [{ id: 'test-llm', name: 'Test LLM' }],
    },
  }

  const config = {
    providers: {
      get: () => ({
        'test-llm': {
          enabled: true,
          protocol: 'http',
          host: '127.0.0.1',
          port: deadPort,
          localDirect: false, // force through proxy
        },
      }),
    },
    enableFallbackDirect: {
      get: () => true,
    },
    localDirect: {
      get: () => false,
    },
  }

  apply(mockCtx, config)

  const streamListener = listeners.find(l => l.event === 'llm/stream')
  assert.ok(streamListener, 'llm/stream listener registered')

  const wrappedStream = streamListener.fn(
    { provider: 'test-llm' },
    () =>
      (async function* () {
        await new Promise(resolve => setImmediate(resolve))
        const res = await fetch(origin.url)
        yield await res.json()
      })(),
  )

  const chunks = []
  for await (const chunk of wrappedStream) {
    chunks.push(chunk)
  }

  assert.equal(chunks.length, 1)
  assert.equal((chunks[0] as any).origin, true)

  const state = mockCtx.providerProxyState
  assert.ok(state, 'providerProxyState exposed')
  const lastUse = state.lastUse['test-llm']
  assert.ok(lastUse, 'lastUse recorded for test-llm')
  assert.equal(lastUse.ok, true, 'lastUse is ok')
  assert.equal(lastUse.fallback, true, 'lastUse marked fallback: true')
  assert.equal(lastUse.code, '[告警: 代理宕机，已降级直连]')

  await origin.close()
})

test('N18: when fallback direct fetch also fails, throws the real direct error', async () => {
  const deadPort = await getUnusedPort()
  // Hold the port while the test runs and destroy every connection: a port
  // picked from the ephemeral range can be claimed by a concurrently running
  // test file before the fallback fetch reaches it, which made this assertion
  // flaky on CI.
  const deadOrigin = createTcpServer(socket => socket.destroy())
  await new Promise(resolve => deadOrigin.listen(0, '127.0.0.1', resolve))
  const deadOriginPort = (deadOrigin.address() as { port: number }).port
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort}` })

  let onFallbackCalled = false
  let settledOk: boolean | undefined
  let settledFallback: boolean | undefined

  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        enableFallbackDirect: true,
        onFallback: () => {
          onFallbackCalled = true
        },
        onSettle: (ok, _detail, meta) => {
          settledOk = ok
          settledFallback = meta?.fallback
        },
      },
      () =>
        (async function* () {
          await new Promise(resolve => setImmediate(resolve))
          await fetch(`http://127.0.0.1:${deadOriginPort}/target`)
          yield 1
        })(),
    )

    await assert.rejects(async () => {
      for await (const _ of stream) {
        // fails
      }
    })

    assert.equal(onFallbackCalled, true, 'fallback was attempted')
    assert.equal(settledOk, false, 'settled as failed')
    assert.equal(settledFallback, true, 'settled marked fallback: true')
  } finally {
    await agent.close()
    await new Promise(resolve => deadOrigin.close(resolve))
    router.release()
  }
})

test('P1-4: a connection reset by the proxy is NOT re-sent, and the real error surfaces', async () => {
  const origin = await startOriginServer()
  const proxy = await startResettingProxy()
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })

  let onFallbackCalled = false
  let settledFallback: boolean | undefined

  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        enableFallbackDirect: true,
        onFallback: () => {
          onFallbackCalled = true
        },
        onSettle: (_ok, _detail, meta) => {
          settledFallback = meta?.fallback
        },
      },
      () =>
        (async function* () {
          await new Promise(resolve => setImmediate(resolve))
          const response = await fetch(origin.url, {
            method: 'POST',
            body: 'payload',
            headers: { 'content-type': 'text/plain' },
          })
          yield response.status
        })(),
    )

    const error = await rejectionOf(stream)

    assert.equal(onFallbackCalled, false, 'a reset must not authorise a second attempt')
    assert.equal(settledFallback, false, 'the settle record must not claim a fallback')
    assert.equal(origin.getHits(), 0, 'the request must never be replayed against the origin')
    assert.equal(proxy.seen.length, 1, 'the proxy did receive the first attempt')
    assert.ok(error instanceof Error, 'the original error must not be swallowed')
    assert.ok(
      errorCodes(error).includes('ECONNRESET'),
      'this scenario must really produce a reset, or it proves nothing about the boundary',
    )
  } finally {
    await agent.close()
    router.release()
    await proxy.close()
    await origin.close()
  }
})

test("P1-4: the caller's own timeout is NOT retried, and TimeoutError surfaces unchanged", async () => {
  const proxy = await startSilentProxy()
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })

  let onFallbackCalled = false

  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        enableFallbackDirect: true,
        onFallback: () => {
          onFallbackCalled = true
        },
      },
      () =>
        (async function* () {
          await new Promise(resolve => setImmediate(resolve))
          await fetch('http://timeout-target.invalid/v1/messages', {
            signal: AbortSignal.timeout(120),
          })
          yield 1
        })(),
    )

    const error = await rejectionOf(stream)

    assert.equal(onFallbackCalled, false, 'a caller timeout must not authorise a retry')
    assert.equal(
      (error as Error)?.name,
      'TimeoutError',
      'the call fails with the caller\'s own timeout, not a rewritten error',
    )
  } finally {
    await agent.close()
    router.release()
    await proxy.close()
  }
})

test('P1-4: a request whose body is a stream is not replayed, so its error is not lost', async () => {
  const origin = await startOriginServer()
  const deadPort = await getUnusedPort()
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort}` })

  let onFallbackCalled = false

  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        enableFallbackDirect: true,
        onFallback: () => {
          onFallbackCalled = true
        },
      },
      () =>
        (async function* () {
          await new Promise(resolve => setImmediate(resolve))
          const response = await fetch(origin.url, {
            method: 'POST',
            // A live stream: the first attempt consumes it, so a retry could only
            // throw TypeError and hide the reason the proxy failed.
            body: Readable.from(['chunk-one', 'chunk-two']),
            headers: { 'content-type': 'text/plain' },
          })
          yield response.status
        })(),
    )

    const error = await rejectionOf(stream)

    assert.equal(onFallbackCalled, false, 'a streamed body must never be re-sent')
    assert.equal(origin.getHits(), 0, 'nothing reached the origin')
    assert.notEqual(
      String((error as Error)?.message ?? '').includes('body used already'),
      true,
      'the transport error must not be replaced by a body-reuse TypeError',
    )
  } finally {
    await agent.close()
    router.release()
    await origin.close()
  }
})
