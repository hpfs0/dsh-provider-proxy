import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { ProxyAgent } from 'undici'

import {
  acquireFetchRouter,
  apply,
  buildRouteEntry,
  closeTable,
  normalizeDefaultProxy,
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

async function startRecordingProxy(name = 'proxy') {
  let hits = 0
  const seen: { host?: string; url?: string }[] = []
  const server = createServer((req, res) => {
    hits += 1
    seen.push({ host: req.headers.host, url: req.url })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ via: name, hits }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as { port: number }
  return {
    name,
    port,
    seen,
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

test('N26: router level - primary down switches to standby preset and returns 200', async () => {
  const origin = await startOriginServer()
  const deadPort = await getUnusedPort()
  const standbyProxy = await startRecordingProxy('standby-1')

  const router = acquireFetchRouter()
  const primaryAgent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort}` })
  const standbyAgent = new ProxyAgent({ uri: `http://127.0.0.1:${standbyProxy.port}` })

  let failoverProfileRecorded: string | undefined
  let settledMeta: any

  try {
    const stream = router.wrap(
      {
        dispatcher: primaryAgent,
        enableProxyFailover: true,
        standbyDispatchers: [{ profileId: 'standby-node-1', dispatcher: standbyAgent }],
        onFailover: profileId => {
          failoverProfileRecorded = profileId
        },
        onSettle: (_ok, _detail, meta) => {
          settledMeta = meta
        },
      },
      () =>
        (async function* () {
          await new Promise(resolve => setImmediate(resolve))
          const res = await fetch(origin.url)
          yield await res.json()
        })(),
    )

    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    assert.equal(chunks.length, 1)
    assert.equal((chunks[0] as any).via, 'standby-1')
    assert.equal(standbyProxy.getHits(), 1, 'standby proxy received request')
    assert.equal(failoverProfileRecorded, 'standby-node-1', 'onFailover fired with correct profile ID')
    assert.equal(settledMeta?.failoverProfileId, 'standby-node-1', 'meta.failoverProfileId is populated')
    assert.equal(settledMeta?.fallback, false, 'fallback is false since proxy carried the request')
  } finally {
    await primaryAgent.close()
    await standbyAgent.close()
    router.release()
    await standbyProxy.close()
    await origin.close()
  }
})

test('N26: router level - multiple standbys tried in order until a healthy one answers', async () => {
  const origin = await startOriginServer()
  const deadPort1 = await getUnusedPort()
  const deadPort2 = await getUnusedPort()
  const healthyStandby = await startRecordingProxy('standby-healthy')

  const router = acquireFetchRouter()
  const primaryAgent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort1}` })
  const deadStandbyAgent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort2}` })
  const healthyStandbyAgent = new ProxyAgent({ uri: `http://127.0.0.1:${healthyStandby.port}` })

  let failoverProfileRecorded: string | undefined
  let settledMeta: any

  try {
    const stream = router.wrap(
      {
        dispatcher: primaryAgent,
        enableProxyFailover: true,
        standbyDispatchers: [
          { profileId: 'standby-dead', dispatcher: deadStandbyAgent },
          { profileId: 'standby-ok', dispatcher: healthyStandbyAgent },
        ],
        onFailover: profileId => {
          failoverProfileRecorded = profileId
        },
        onSettle: (_ok, _detail, meta) => {
          settledMeta = meta
        },
      },
      () =>
        (async function* () {
          await new Promise(resolve => setImmediate(resolve))
          const res = await fetch(origin.url)
          yield await res.json()
        })(),
    )

    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    assert.equal(chunks.length, 1)
    assert.equal((chunks[0] as any).via, 'standby-healthy')
    assert.equal(healthyStandby.getHits(), 1)
    assert.equal(failoverProfileRecorded, 'standby-ok')
    assert.equal(settledMeta?.failoverProfileId, 'standby-ok')
  } finally {
    await primaryAgent.close()
    await deadStandbyAgent.close()
    await healthyStandbyAgent.close()
    router.release()
    await healthyStandby.close()
    await origin.close()
  }
})

test('N26: router level - all standbys down with enableFallbackDirect false strictly fails closed', async () => {
  const origin = await startOriginServer()
  const deadPort1 = await getUnusedPort()
  const deadPort2 = await getUnusedPort()

  const router = acquireFetchRouter()
  const primaryAgent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort1}` })
  const standbyAgent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort2}` })

  let onFallbackCalled = false
  let settledOk: boolean | undefined

  try {
    const stream = router.wrap(
      {
        dispatcher: primaryAgent,
        enableProxyFailover: true,
        enableFallbackDirect: false,
        standbyDispatchers: [{ profileId: 'standby-dead', dispatcher: standbyAgent }],
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
        // must fail
      }
    })

    assert.equal(onFallbackCalled, false, 'onFallback must not be called')
    assert.equal(settledOk, false, 'settled with ok: false')
    assert.equal(origin.getHits(), 0, 'origin must not be touched directly')
  } finally {
    await primaryAgent.close()
    await standbyAgent.close()
    router.release()
    await origin.close()
  }
})

test('N26: router level - all standbys down with enableFallbackDirect true falls back to direct', async () => {
  const origin = await startOriginServer()
  const deadPort1 = await getUnusedPort()
  const deadPort2 = await getUnusedPort()

  const router = acquireFetchRouter()
  const primaryAgent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort1}` })
  const standbyAgent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort2}` })

  let onFallbackCalled = false
  let settledMeta: any

  try {
    const stream = router.wrap(
      {
        dispatcher: primaryAgent,
        enableProxyFailover: true,
        enableFallbackDirect: true,
        standbyDispatchers: [{ profileId: 'standby-dead', dispatcher: standbyAgent }],
        onFallback: () => {
          onFallbackCalled = true
        },
        onSettle: (_ok, _detail, meta) => {
          settledMeta = meta
        },
      },
      () =>
        (async function* () {
          await new Promise(resolve => setImmediate(resolve))
          const res = await fetch(origin.url)
          yield await res.json()
        })(),
    )

    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }

    assert.equal(chunks.length, 1)
    assert.equal((chunks[0] as any).origin, true, 'arrived direct at origin')
    assert.equal(origin.getHits(), 1, 'origin received direct request')
    assert.equal(onFallbackCalled, true, 'onFallback was called')
    assert.equal(settledMeta?.fallback, true, 'meta.fallback is true')
    assert.equal(settledMeta?.failoverProfileId, undefined, 'no failoverProfileId on direct fallback')
  } finally {
    await primaryAgent.close()
    await standbyAgent.close()
    router.release()
    await origin.close()
  }
})

test('N26: router level - failback: primary failure sets cooldown, then primary recovery restores primary routing', async () => {
  const origin = await startOriginServer()
  const standbyProxy = await startRecordingProxy('standby-proxy')
  let primaryProxy: Awaited<ReturnType<typeof startRecordingProxy>> | undefined

  const deadPort = await getUnusedPort()
  const router = acquireFetchRouter()

  // Initially primary points to deadPort
  let primaryAgent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort}` })
  const standbyAgent = new ProxyAgent({ uri: `http://127.0.0.1:${standbyProxy.port}` })

  let primaryFailTimestamp: number | undefined
  const cooldownMs = 80

  const store = {
    get dispatcher() {
      return primaryAgent
    },
    enableProxyFailover: true,
    failbackCooldownMs: cooldownMs,
    standbyDispatchers: [{ profileId: 'standby-node', dispatcher: standbyAgent }],
    isPrimaryFailed: () => {
      if (primaryFailTimestamp === undefined) return false
      return Date.now() - primaryFailTimestamp < cooldownMs
    },
    markPrimaryFailed: () => {
      primaryFailTimestamp = Date.now()
    },
    markPrimaryRecovered: () => {
      primaryFailTimestamp = undefined
    },
    onSettle: (_ok: boolean, _detail: unknown, _meta?: any) => {},
  }

  try {
    // Request 1: Primary is dead -> failover to standby
    let meta1: any
    store.onSettle = (_ok, _detail, meta) => {
      meta1 = meta
    }
    const res1 = await router.run(store, async () => {
      const res = await fetch(origin.url)
      return res.json()
    })
    assert.equal((res1 as any).via, 'standby-proxy')
    assert.equal(meta1?.failoverProfileId, 'standby-node')
    assert.ok(primaryFailTimestamp !== undefined, 'primary was marked failed')

    // Request 2: While under cooldown, request goes straight to standby without hitting primary
    let meta2: any
    store.onSettle = (_ok, _detail, meta) => {
      meta2 = meta
    }
    const res2 = await router.run(store, async () => {
      const res = await fetch(origin.url)
      return res.json()
    })
    assert.equal((res2 as any).via, 'standby-proxy')
    assert.equal(meta2?.failoverProfileId, 'standby-node')
    assert.equal(standbyProxy.getHits(), 2)

    // Now Primary recovers! Start primary proxy on a real port and swap primaryAgent
    primaryProxy = await startRecordingProxy('primary-proxy')
    await primaryAgent.close()
    primaryAgent = new ProxyAgent({ uri: `http://127.0.0.1:${primaryProxy.port}` })

    // Wait for cooldown to expire
    await new Promise(resolve => setTimeout(resolve, cooldownMs + 20))
    assert.equal(store.isPrimaryFailed(), false, 'cooldown expired')

    // Request 3: Probes recovered primary first
    let meta3: any
    store.onSettle = (_ok, _detail, meta) => {
      meta3 = meta
    }
    const res3 = await router.run(store, async () => {
      const res = await fetch(origin.url)
      return res.json()
    })
    assert.equal((res3 as any).via, 'primary-proxy')
    assert.equal(meta3?.failoverProfileId, undefined, 'no failover; primary handled it')
    assert.equal(primaryProxy.getHits(), 1, 'primary proxy handled the request')
    assert.equal(primaryFailTimestamp, undefined, 'primary is marked recovered (Failback complete)')
  } finally {
    await primaryAgent.close()
    await standbyAgent.close()
    router.release()
    await standbyProxy.close()
    if (primaryProxy) await primaryProxy.close()
    await origin.close()
  }
})

test('N26: P1-4 - primary CONNECT then RST (ECONNRESET) does NOT failover and does NOT replay', async () => {
  const origin = await startOriginServer()
  const rstProxy = await startResettingProxy()
  const standbyProxy = await startRecordingProxy('standby-p14')

  const router = acquireFetchRouter()
  const rstAgent = new ProxyAgent({ uri: `http://127.0.0.1:${rstProxy.port}` })
  const standbyAgent = new ProxyAgent({ uri: `http://127.0.0.1:${standbyProxy.port}` })

  let onFailoverFired = false
  let settledOk: boolean | undefined

  try {
    const stream = router.wrap(
      {
        dispatcher: rstAgent,
        enableProxyFailover: true,
        standbyDispatchers: [{ profileId: 'standby-p14', dispatcher: standbyAgent }],
        onFailover: () => {
          onFailoverFired = true
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
        // must fail with reset
      }
    })

    assert.equal(onFailoverFired, false, 'onFailover must NOT fire on RST')
    assert.equal(standbyProxy.getHits(), 0, 'standby proxy must NEVER be touched on RST')
    assert.equal(settledOk, false)
  } finally {
    await rstAgent.close()
    await standbyAgent.close()
    router.release()
    await rstProxy.close()
    await standbyProxy.close()
    await origin.close()
  }
})

test('N26: P1-4 - non-replayable stream body does NOT failover on primary connection failure', async () => {
  const origin = await startOriginServer()
  const deadPort = await getUnusedPort()
  const standbyProxy = await startRecordingProxy('standby-p14-stream')

  const router = acquireFetchRouter()
  const primaryAgent = new ProxyAgent({ uri: `http://127.0.0.1:${deadPort}` })
  const standbyAgent = new ProxyAgent({ uri: `http://127.0.0.1:${standbyProxy.port}` })

  let onFailoverFired = false

  try {
    const stream = router.wrap(
      {
        dispatcher: primaryAgent,
        enableProxyFailover: true,
        standbyDispatchers: [{ profileId: 'standby-p14-stream', dispatcher: standbyAgent }],
        onFailover: () => {
          onFailoverFired = true
        },
      },
      () =>
        (async function* () {
          await new Promise(resolve => setImmediate(resolve))
          const unreplayableBody = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('stream content'))
              controller.close()
            },
          })
          await fetch(origin.url, {
            method: 'POST',
            body: unreplayableBody,
            // @ts-expect-error duplex required for streaming body in fetch
            duplex: 'half',
          })
          yield 1
        })(),
    )

    await assert.rejects(async () => {
      for await (const _ of stream) {
        // must fail
      }
    })

    assert.equal(onFailoverFired, false, 'must NOT failover with streaming body')
    assert.equal(standbyProxy.getHits(), 0, 'standby proxy must NOT be contacted')
  } finally {
    await primaryAgent.close()
    await standbyAgent.close()
    router.release()
    await standbyProxy.close()
    await origin.close()
  }
})

test('N26: proxy-table - buildRouteEntry builds standbyDispatchers for valid profiles', async () => {
  const defaultProxy = normalizeDefaultProxy({ host: '', port: 0 })
  const profiles = {
    'standby-hk': { protocol: 'http' as const, host: '127.0.0.1', port: 1081 },
    'standby-sg': { protocol: 'http' as const, host: '127.0.0.1', port: 1082 },
  }

  const built = buildRouteEntry(
    'openai',
    {
      enabled: true,
      protocol: 'http',
      host: '127.0.0.1',
      port: 1080,
      enableProxyFailover: true,
      backupProfileIds: ['standby-hk', 'standby-sg'],
    },
    { defaultProxy, profiles, requireEnabled: true, localDirect: true },
  )

  assert.equal(built.ok, true)
  if (built.ok) {
    assert.equal(built.entry.standbyDispatchers.length, 2)
    assert.equal(built.entry.standbyDispatchers[0].profileId, 'standby-hk')
    assert.equal(built.entry.standbyDispatchers[1].profileId, 'standby-sg')

    const map = new Map([['openai', built.entry]])
    await closeTable(map)
    assert.equal(map.size, 0)
  }
})

test('N26: e2e apply() - llm/stream switches to standby and updates lastUse with failover alert', async () => {
  const origin = await startOriginServer()
  const deadPort = await getUnusedPort()
  const standbyProxy = await startRecordingProxy('standby-e2e')

  try {
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
        listProviders: () => [{ id: 'failover-llm', name: 'Failover LLM' }],
      },
    }

    const config = {
      providers: {
        get: () => ({
          'failover-llm': {
            enabled: true,
            protocol: 'http',
            host: '127.0.0.1',
            port: deadPort,
            enableProxyFailover: true,
            backupProfileIds: ['profile-standby'],
            localDirect: false,
          },
        }),
      },
      proxyProfiles: {
        get: () => ({
          'profile-standby': {
            protocol: 'http',
            host: '127.0.0.1',
            port: standbyProxy.port,
          },
        }),
      },
      localDirect: {
        get: () => false,
      },
    }

    apply(mockCtx, config)

    const streamListener = listeners.find(l => l.event === 'llm/stream')
    assert.ok(streamListener, 'llm/stream listener registered')

    const wrappedStream = streamListener.fn(
      { provider: 'failover-llm' },
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
    assert.equal((chunks[0] as any).via, 'standby-e2e')
    assert.equal(standbyProxy.getHits(), 1)

    const state = mockCtx.providerProxyState
    assert.ok(state, 'providerProxyState exposed')
    const lastUse = state.lastUse['failover-llm']
    assert.ok(lastUse, 'lastUse recorded for failover-llm')
    assert.equal(lastUse.ok, true, 'lastUse is ok')
    assert.equal(lastUse.failoverProfileId, 'profile-standby')
    assert.equal(lastUse.code, '[故障切换: 备用节点 profile-standby]')
  } finally {
    await standbyProxy.close()
    await origin.close()
  }
})
