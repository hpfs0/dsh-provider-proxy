import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ProxyAgent } from 'undici'

import {
  acquireFetchRouter,
  apply,
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

test('isNetworkFailoverError classifies network and connection errors correctly', () => {
  assert.equal(isNetworkFailoverError(null), false)
  assert.equal(isNetworkFailoverError(undefined), false)
  assert.equal(isNetworkFailoverError(new Error('ordinary error')), false)

  assert.equal(isNetworkFailoverError({ code: 'ECONNREFUSED' }), true)
  assert.equal(isNetworkFailoverError({ code: 'ETIMEDOUT' }), true)
  assert.equal(isNetworkFailoverError({ code: 'EHOSTUNREACH' }), true)
  assert.equal(isNetworkFailoverError({ code: 'ENETUNREACH' }), true)
  assert.equal(isNetworkFailoverError({ name: 'ConnectTimeoutError' }), true)

  const wrapped = new TypeError('fetch failed')
  ;(wrapped as any).cause = { code: 'ECONNREFUSED' }
  assert.equal(isNetworkFailoverError(wrapped), true)
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
  const deadOriginPort = await getUnusedPort()
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
    router.release()
  }
})
