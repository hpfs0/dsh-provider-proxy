import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { ProxyAgent } from 'undici'

import {
  acquireFetchRouter,
  apply,
  fullJitterBackoff,
  isIdempotentRequest,
} from '../lib/index.js'

async function startOriginServer() {
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ origin: true, hits }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as { port: number }
  return {
    port,
    url: `http://127.0.0.1:${port}/upstream`,
    getHits: () => hits,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

async function startFlakyProxy(options: { failStatus?: number; failCount?: number }) {
  let hits = 0
  const failStatus = options.failStatus ?? 502
  const failCount = options.failCount ?? 1
  const server = createServer((req, res) => {
    hits += 1
    if (hits <= failCount) {
      res.writeHead(failStatus, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `flaky error ${failStatus}`, hits }))
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ success: true, hits }))
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as { port: number }
  return {
    port,
    getHits: () => hits,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

async function startPermanentStatusProxy(status: number) {
  let hits = 0
  const server = createServer((req, res) => {
    hits += 1
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: `status ${status}`, hits }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as { port: number }
  return {
    port,
    getHits: () => hits,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

async function getUnusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as { port: number }
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}

async function startResettingProxy() {
  const seen: string[] = []
  const server = createTcpServer(socket => {
    socket.on('error', () => {})
    socket.once('data', chunk => {
      seen.push(String(chunk))
      socket.resetAndDestroy()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as { port: number }
  return {
    seen,
    port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

test('N29: fullJitterBackoff - correctly respects bounds and caps', () => {
  assert.equal(fullJitterBackoff(0, 0), 0)
  assert.equal(fullJitterBackoff(1, -10), 0)

  // Distribution check for attempt 0 (cap: min(5000, 100 * 2^0) = 100)
  for (let i = 0; i < 50; i++) {
    const delay = fullJitterBackoff(0, 100, 5000)
    assert.ok(delay >= 0 && delay <= 100, `delay ${delay} should be in [0, 100]`)
  }

  // Distribution check for attempt 2 (cap: min(5000, 100 * 2^2) = 400)
  for (let i = 0; i < 50; i++) {
    const delay = fullJitterBackoff(2, 100, 5000)
    assert.ok(delay >= 0 && delay <= 400, `delay ${delay} should be in [0, 400]`)
  }

  // Cap check: attempt 10 with cap 5000
  for (let i = 0; i < 50; i++) {
    const delay = fullJitterBackoff(10, 100, 5000)
    assert.ok(delay >= 0 && delay <= 5000, `delay ${delay} should not exceed cap 5000`)
  }
})

test('N29: only idempotent methods are eligible for 5xx retry', () => {
  assert.equal(isIdempotentRequest('http://x.invalid', undefined), true, 'no method means GET')
  assert.equal(isIdempotentRequest('http://x.invalid', { method: 'GET' }), true)
  assert.equal(isIdempotentRequest('http://x.invalid', { method: 'POST' }), false)
  assert.equal(isIdempotentRequest('http://x.invalid', { method: 'PATCH' }), false)
  assert.equal(isIdempotentRequest('http://x.invalid', { method: 'PUT' }), true)
  assert.equal(isIdempotentRequest('http://x.invalid', { method: 'DELETE' }), true)
  assert.equal(
    isIdempotentRequest(new Request('http://x.invalid', { method: 'POST' }), undefined),
    false,
    'a Request carries its own method',
  )
})

test('N29: router level - a POST with a replayable body is NOT retried on 502', async () => {
  const proxy = await startPermanentStatusProxy(502)
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })
  let retried = 0

  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        retryAttempts: 2,
        retryBackoffBaseMs: 1,
        onRetry: () => {
          retried += 1
        },
      },
      () =>
        (async function* () {
          const res = await globalThis.fetch('http://post.invalid/v1/messages', {
            method: 'POST',
            body: JSON.stringify({ message: 'must not be replayed after a gateway 502' }),
          })
          yield res.status
        })(),
    )

    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)

    assert.equal(proxy.getHits(), 1, 'the POST must be sent exactly once')
    assert.equal(retried, 0, 'no retry callback for a non-idempotent 5xx')
    assert.deepEqual(chunks, [502], 'the final 502 is returned to the caller')
  } finally {
    await proxy.close()
    router.release()
  }
})

test('N29: router level - transient 502 is retried once and client receives 200', async () => {
  const origin = await startOriginServer()
  const proxy = await startFlakyProxy({ failStatus: 502, failCount: 1 })
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })

  const retriesRecorded: Array<{ attempt: number; status?: number }> = []
  let settledMeta: any

  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        retryAttempts: 2,
        retryBackoffBaseMs: 10,
        onRetry: (attempt, reason: any) => {
          retriesRecorded.push({ attempt, status: reason?.status })
        },
        onSettle: (_ok, _detail, meta) => {
          settledMeta = meta
        },
      },
      () =>
        (async function* () {
          const res = await globalThis.fetch(origin.url)
          yield await res.json()
        })(),
    )

    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    assert.equal(proxy.getHits(), 2, 'flaky proxy should have been hit twice (initial + 1 retry)')
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0].success, true, 'client should receive successful response after retry')
    assert.equal(retriesRecorded.length, 1, 'onRetry should be called once')
    assert.equal(retriesRecorded[0].attempt, 1)
    assert.equal(retriesRecorded[0].status, 502)
    assert.equal(settledMeta?.retries, 1, 'onSettle should record 1 retry')
  } finally {
    await proxy.close()
    await origin.close()
  }
})

test('N29: router level - 503 and 504 are also retried and succeed on recovery', async () => {
  for (const status of [503, 504]) {
    const origin = await startOriginServer()
    const proxy = await startFlakyProxy({ failStatus: status, failCount: 1 })
    const router = acquireFetchRouter()
    const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })

    let retried = false
    try {
      const stream = router.wrap(
        {
          dispatcher: agent,
          retryAttempts: 2,
          retryBackoffBaseMs: 10,
          onRetry: () => {
            retried = true
          },
        },
        () =>
          (async function* () {
            const res = await globalThis.fetch(origin.url)
            yield await res.json()
          })(),
      )

      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      assert.equal(chunks[0].success, true)
      assert.equal(proxy.getHits(), 2)
      assert.equal(retried, true)
    } finally {
      await proxy.close()
      await origin.close()
    }
  }
})

test('N29: router level - permanent 502 exhausts retryAttempts and returns final 502 response', async () => {
  const origin = await startOriginServer()
  const proxy = await startPermanentStatusProxy(502)
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })

  const retriesRecorded: number[] = []
  let settledOk: boolean | undefined
  let settledMeta: any

  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        retryAttempts: 2,
        retryBackoffBaseMs: 10,
        onRetry: (attempt) => {
          retriesRecorded.push(attempt)
        },
        onSettle: (ok, _detail, meta) => {
          settledOk = ok
          settledMeta = meta
        },
      },
      () =>
        (async function* () {
          const res = await globalThis.fetch(origin.url)
          yield res.status
        })(),
    )

    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    // 1 initial attempt + 2 retries = 3 requests
    assert.equal(proxy.getHits(), 3, 'proxy should be hit 3 times (initial + 2 retries)')
    assert.equal(chunks[0], 502, 'final status returned to client must be 502')
    assert.deepEqual(retriesRecorded, [1, 2], 'retries recorded should be [1, 2]')
    assert.equal(settledOk, false, 'onSettle ok should be false')
    assert.equal(settledMeta?.retries, 2, 'settledMeta retries should be 2')
  } finally {
    await proxy.close()
    await origin.close()
  }
})

test('N29: router level - 400 / 401 / 403 are NOT retried and return immediately', async () => {
  for (const status of [400, 401, 403]) {
    const origin = await startOriginServer()
    const proxy = await startPermanentStatusProxy(status)
    const router = acquireFetchRouter()
    const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })

    let retried = false
    try {
      const stream = router.wrap(
        {
          dispatcher: agent,
          retryAttempts: 3,
          retryBackoffBaseMs: 10,
          onRetry: () => {
            retried = true
          },
        },
        () =>
          (async function* () {
            const res = await globalThis.fetch(origin.url)
            yield res.status
          })(),
      )

      const chunks = []
      for await (const chunk of stream) chunks.push(chunk)
      assert.equal(chunks[0], status)
      assert.equal(proxy.getHits(), 1, `status ${status} must NOT be retried: hit count must be exactly 1`)
      assert.equal(retried, false, `onRetry must not be called for status ${status}`)
    } finally {
      await proxy.close()
      await origin.close()
    }
  }
})

test('N29: router level - 407 Proxy Authentication Required throws immediately without retry', async () => {
  const origin = await startOriginServer()
  const proxy = await startPermanentStatusProxy(407)
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })

  let retried = false
  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        retryAttempts: 3,
        retryBackoffBaseMs: 10,
        onRetry: () => {
          retried = true
        },
      },
      () =>
        (async function* () {
          const res = await globalThis.fetch(origin.url)
          yield res.status
        })(),
    )

    await assert.rejects(async () => {
      for await (const _chunk of stream) {}
    })
    assert.equal(proxy.getHits(), 1, '407 must NOT be retried: hit count must be exactly 1')
    assert.equal(retried, false, 'onRetry must not be called for 407')
  } finally {
    await proxy.close()
    await origin.close()
  }
})

test('N29: router level - connect error (ECONNREFUSED) retries on candidate before failing', async () => {
  const origin = await startOriginServer()
  const deadPort = await getUnusedPort()
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort}` })

  const retriesRecorded: number[] = []
  let settledOk: boolean | undefined
  let settledMeta: any

  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        retryAttempts: 2,
        retryBackoffBaseMs: 10,
        onRetry: (attempt) => {
          retriesRecorded.push(attempt)
        },
        onSettle: (ok, _detail, meta) => {
          settledOk = ok
          settledMeta = meta
        },
      },
      () =>
        (async function* () {
          const res = await globalThis.fetch(origin.url)
          yield await res.json()
        })(),
    )

    await assert.rejects(async () => {
      for await (const _chunk of stream) {}
    })

    assert.deepEqual(retriesRecorded, [1, 2], 'should have retried connect error twice')
    assert.equal(settledOk, false)
    assert.equal(settledMeta?.retries, 2)
  } finally {
    await origin.close()
  }
})

test('N29: P1-4 - post-connect ECONNRESET is strictly NOT retried', async () => {
  const origin = await startOriginServer()
  const resetProxy = await startResettingProxy()
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${resetProxy.port}` })

  let retried = false
  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        retryAttempts: 3,
        retryBackoffBaseMs: 10,
        onRetry: () => {
          retried = true
        },
      },
      () =>
        (async function* () {
          const res = await globalThis.fetch(origin.url, {
            method: 'POST',
            body: JSON.stringify({ message: 'cannot replay if reset after upstream contact' }),
          })
          yield await res.json()
        })(),
    )

    await assert.rejects(async () => {
      for await (const _chunk of stream) {}
    })

    assert.equal(retried, false, 'ECONNRESET must NOT trigger retry')
    assert.equal(resetProxy.seen.length, 1, 'upstream proxy must only see the single attempt')
  } finally {
    await resetProxy.close()
    await origin.close()
  }
})

test('N29: P1-4 - non-replayable body (ReadableStream) is NOT retried on 502', async () => {
  const origin = await startOriginServer()
  const proxy = await startFlakyProxy({ failStatus: 502, failCount: 1 })
  const router = acquireFetchRouter()
  const agent = new ProxyAgent({ uri: `http://127.0.0.1:${proxy.port}` })

  let retried = false
  try {
    const stream = router.wrap(
      {
        dispatcher: agent,
        retryAttempts: 2,
        retryBackoffBaseMs: 10,
        onRetry: () => {
          retried = true
        },
      },
      () =>
        (async function* () {
          const bodyStream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('streaming request body'))
              controller.close()
            },
          })
          const res = await globalThis.fetch(origin.url, {
            method: 'POST',
            body: bodyStream,
            // @ts-expect-error duplex required for ReadableStream body in undici
            duplex: 'half',
          })
          yield res.status
        })(),
    )

    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    assert.equal(chunks[0], 502)
    assert.equal(proxy.getHits(), 1, 'ReadableStream body cannot be replayed: hits must be 1')
    assert.equal(retried, false, 'onRetry must not be called')
  } finally {
    await proxy.close()
    await origin.close()
  }
})

test('N29: e2e apply() - llm/stream retries transient 502 and records retry count', async () => {
  const origin = await startOriginServer()
  const proxy = await startFlakyProxy({ failStatus: 502, failCount: 1 })

  const listeners: Array<{ event: string; fn: Function }> = []
  const mockCtx = {
    on: (event: string, fn: Function) => {
      listeners.push({ event, fn })
      return () => {}
    },
    effect: (fn: Function) => {
      fn()
      return () => {}
    },
  }

  const config = {
    providers: {
      get: () => ({
        'retry-llm': {
          enabled: true,
          protocol: 'http',
          host: '127.0.0.1',
          port: proxy.port,
          localDirect: false,
        },
      }),
    },
    retryAttempts: {
      get: () => 2,
    },
    retryBackoffBaseMs: {
      get: () => 10,
    },
    localDirect: {
      get: () => false,
    },
  }

  try {
    apply(mockCtx, config as any)

    const streamListener = listeners.find(l => l.event === 'llm/stream')
    assert.ok(streamListener, 'llm/stream listener must be registered')

    const nextFn = () =>
      (async function* () {
        await new Promise(resolve => setImmediate(resolve))
        const res = await globalThis.fetch(origin.url)
        yield await res.json()
      })()

    const wrappedStream = streamListener.fn({ provider: 'retry-llm' }, nextFn)
    const results = []
    for await (const item of wrappedStream) {
      results.push(item)
    }

    assert.equal(proxy.getHits(), 2, 'llm/stream should retry transient 502 once')
    assert.equal(results.length, 1)
    assert.equal(results[0].success, true)
  } finally {
    await proxy.close()
    await origin.close()
  }
})
