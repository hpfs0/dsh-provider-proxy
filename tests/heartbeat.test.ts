import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  Config,
  normalizeHeartbeatConfig,
  countUnreachableProviders,
  apply,
} from '../lib/index.js'

function read(node: unknown): any {
  const get = (node as { get?: () => unknown })?.get
  return typeof get === 'function' ? get.call(node) : node
}

test('N23: Config schema defaults for heartbeat monitoring', () => {
  const parsed = Config({})
  assert.equal(read(parsed.heartbeatEnabled), false, 'heartbeatEnabled must default to false (zero extra traffic)')
  assert.equal(read(parsed.heartbeatInterval), 300, 'heartbeatInterval must default to 300s')
  assert.equal(read(parsed.heartbeatConsecutiveFails), 2, 'heartbeatConsecutiveFails must default to 2')
})

test('N23: normalizeHeartbeatConfig sanitizes and bounds inputs', () => {
  // Empty
  const def = normalizeHeartbeatConfig()
  assert.deepEqual(def, {
    heartbeatEnabled: false,
    heartbeatInterval: 300,
    heartbeatConsecutiveFails: 2,
  })

  // Valid custom values
  const custom = normalizeHeartbeatConfig({
    heartbeatEnabled: true,
    heartbeatInterval: 60,
    heartbeatConsecutiveFails: 3,
  })
  assert.deepEqual(custom, {
    heartbeatEnabled: true,
    heartbeatInterval: 60,
    heartbeatConsecutiveFails: 3,
  })

  // Out of range & malformed values
  const bounded = normalizeHeartbeatConfig({
    heartbeatEnabled: 'yes' as any,
    heartbeatInterval: 5, // < 10 -> defaults to 300
    heartbeatConsecutiveFails: 0, // < 1 -> defaults to 2
  })
  assert.deepEqual(bounded, {
    heartbeatEnabled: false,
    heartbeatInterval: 300,
    heartbeatConsecutiveFails: 2,
  })
})

test('N23: heartbeat scheduler owns a plain global timer and never reads ctx timer members', async () => {
  // Regression for crash-2026-11-03T09-13-15-493Z-host.log.
  //
  // `@deepseek-ai/cordis` resolves `ctx.setInterval`/`ctx.clearInterval` as
  // accessors over the `timer` service (reflect.ts:144). This plugin injects
  // only `llm`, so the property READ throws `cannot get property "timer"
  // without inject`, the Loader escalates it to `fatal load failure`, and the
  // Host exits with 1 — enabling the switch killed the whole desktop app.
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  let timerRegistered = 0
  let timerCleared = 0
  let intervalCaptured = 0
  globalThis.setInterval = ((_fn: Function, ms: number) => {
    timerRegistered += 1
    intervalCaptured = ms
    return { id: 'global-timer', unref() {} }
  }) as any
  globalThis.clearInterval = ((timer: any) => {
    if (timer?.id === 'global-timer') timerCleared += 1
  }) as any

  // A ctx that throws exactly like an un-injected cordis service on the timer
  // members: any regression back to ctx timers fails loudly instead of crashing
  // the real Host.
  const strict: any = {
    on(event: string, fn: Function) {
      if (event === 'loader/volatile-update') {
        strict.onConfig = fn
      }
      return () => {}
    },
    emit() {},
    effect(fn: Function) {
      strict.cleanup = fn()
      return () => {}
    },
  }
  const forbidden = new Set(['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'timer'])
  const mockCtx: any = new Proxy(strict, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && forbidden.has(prop)) {
        throw new Error(`cannot get property "timer" without inject`)
      }
      return Reflect.get(target, prop, receiver)
    },
  })

  // 1. Initial mount with heartbeatEnabled = false (default)
  let enabled = false
  let interval = 300
  const config = {
    heartbeatEnabled: { get: () => enabled },
    heartbeatInterval: { get: () => interval },
    heartbeatConsecutiveFails: { get: () => 2 },
  }

  try {
    apply(mockCtx, config as any)

    assert.equal(timerRegistered, 0, 'no timer registered when heartbeat is disabled')
    assert.equal(timerCleared, 0)

    // 2. Enable heartbeat via volatile update
    enabled = true
    interval = 60
    mockCtx.onConfig()
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(timerRegistered, 1, 'global timer registered when heartbeat enabled')
    assert.equal(intervalCaptured, 60000, 'timer scheduled at 60s (60000ms)')

    // 3. Update interval
    interval = 900
    mockCtx.onConfig()
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(timerRegistered, 2, 'new timer registered on update')
    assert.equal(timerCleared, 1, 'previous timer cleared on update')
    assert.equal(intervalCaptured, 900000, 'timer rescheduled at 900s')

    // 4. Dispose plugin -> clean destruction
    await mockCtx.cleanup()

    assert.equal(timerCleared, 2, 'timer completely cleared on dispose')
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
})

test('N23: Heartbeat consecutive failure threshold and unreachable status transition', async () => {
  let failsRemaining = 2
  const server = createServer((req, res) => {
    if (failsRemaining > 0) {
      failsRemaining -= 1
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'temporarily unavailable' }))
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }
  })

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port
  const targetUrl = `http://127.0.0.1:${port}/health`

  try {
    const mockCtx: any = {
      on: () => () => {},
      emit: () => {},
      effect: (fn: Function) => {
        mockCtx.cleanup = fn()
      },
    }

    const config = {
      heartbeatEnabled: { get: () => true },
      heartbeatInterval: { get: () => 60 },
      heartbeatConsecutiveFails: { get: () => 2 },
      localDirect: { get: () => true }, // direct target
      providers: {
        get: () => ({
          p1: {
            enabled: true,
            protocol: 'http',
            host: '127.0.0.1',
            port: 7890,
            testTarget: targetUrl,
          },
        }),
      },
    }

    apply(mockCtx, config as any)

    // Trigger cycle 1: 1st failure (fails: 1, status remains healthy because threshold is 2)
    failsRemaining = 2
    await mockCtx.providerProxyState.triggerHeartbeatCycle()

    const state1 = mockCtx.providerProxyState.heartbeat.p1
    assert.ok(state1, 'heartbeat record exists for p1')
    assert.equal(state1.fails, 1)
    assert.equal(state1.status, 'healthy', 'must remain healthy on 1st fail when threshold is 2')
    assert.equal(state1.lastSuccessAt, undefined, 'lastSuccessAt must be undefined when it never connected')
    assert.ok(state1.error?.includes('503') || state1.error?.length > 0)

    // Trigger cycle 2: 2nd failure (fails: 2, hits threshold -> transitions to 'unreachable')
    failsRemaining = 1
    await mockCtx.providerProxyState.triggerHeartbeatCycle()

    const state2 = mockCtx.providerProxyState.heartbeat.p1
    assert.equal(state2.fails, 2)
    assert.equal(state2.status, 'unreachable', 'transitions to unreachable after 2 consecutive fails')
    assert.equal(state2.lastSuccessAt, undefined, 'lastSuccessAt stays undefined across failures when never connected')
    assert.ok(state2.error?.includes('503') || state2.error?.length > 0)

    // Verify countUnreachableProviders agrees
    const unreachableCheck = countUnreachableProviders(
      [{ id: 'p1', name: 'P1' }],
      { p1: { enabled: true } },
      mockCtx.providerProxyState.heartbeat,
    )
    assert.equal(unreachableCheck.count, 1)
    assert.deepEqual(unreachableCheck.unreachableIds, ['p1'])

    // Trigger cycle 3: Target recovers (200 OK) -> instant self-healing!
    failsRemaining = 0
    await mockCtx.providerProxyState.triggerHeartbeatCycle()

    const state3 = mockCtx.providerProxyState.heartbeat.p1
    assert.equal(state3.status, 'healthy', 'self-heals immediately to healthy upon recovery')
    assert.equal(state3.fails, 0)
    assert.equal(state3.error, undefined)
    assert.equal(typeof state3.lastSuccessAt, 'number', 'lastSuccessAt is set when probe succeeds')

    // Trigger cycle 4: Fails again -> previous lastSuccessAt is preserved!
    failsRemaining = 1
    await mockCtx.providerProxyState.triggerHeartbeatCycle()

    const state4 = mockCtx.providerProxyState.heartbeat.p1
    assert.equal(state4.fails, 1)
    assert.equal(state4.lastSuccessAt, state3.lastSuccessAt, 'previous lastSuccessAt is preserved across subsequent failure')

    await mockCtx.cleanup?.()
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('N23: Heartbeat self-heals when live stream request settles successfully', async () => {
  const proxy = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const port = (proxy.address() as any).port

  try {
    const mockCtx: any = {
      on(event: string, fn: Function) {
        if (event === 'llm/stream') mockCtx.streamHandler = fn
        return () => {}
      },
      emit: () => {},
      effect: (fn: Function) => {
        mockCtx.cleanup = fn()
      },
    }

    const config = {
      heartbeatEnabled: { get: () => true },
      heartbeatInterval: { get: () => 60 },
      heartbeatConsecutiveFails: { get: () => 1 },
      localDirect: { get: () => true },
      providers: {
        get: () => ({
          p1: {
            enabled: true,
            protocol: 'http',
            host: '127.0.0.1',
            port,
          },
        }),
      },
    }

    apply(mockCtx, config as any)

    // Manually put p1 into unreachable state (simulating a previous outage)
    mockCtx.providerProxyState.setHeartbeatState('p1', {
      status: 'unreachable',
      lastCheckAt: Date.now() - 5000,
      latencyMs: 120,
      error: 'ECONNREFUSED',
      fails: 3,
    })

    assert.equal(mockCtx.providerProxyState.heartbeat.p1.status, 'unreachable')

    // Now a real stream request for p1 settles successfully through the proxy
    const stream = mockCtx.streamHandler(
      { provider: 'p1' },
      () =>
        (async function* () {
          await new Promise(resolve => setImmediate(resolve))
          const res = await fetch('http://api.deepseek.com/chat')
          yield await res.json()
        })(),
    )

    for await (const chunk of stream) {
      // consume
    }

    // Let settle handler finish microtasks
    await new Promise(resolve => setImmediate(resolve))

    // Settle hook runs -> instant self-healing!
    const healed = mockCtx.providerProxyState.heartbeat.p1
    assert.equal(healed.status, 'healthy', 'stream settlement self-heals unreachable state to healthy')
    assert.equal(healed.fails, 0)
    assert.equal(healed.error, undefined)
    assert.equal(typeof healed.lastSuccessAt, 'number', 'stream settlement sets lastSuccessAt')

    await mockCtx.cleanup?.()
  } finally {
    await new Promise(resolve => proxy.close(resolve))
  }
})

test('N23: Disabled and removed routes are cleared from heartbeat state', async () => {
  const mockCtx: any = {
    on(event: string, fn: Function) {
      if (event === 'loader/volatile-update') mockCtx.onConfig = fn
      return () => {}
    },
    emit: () => {},
    effect: (fn: Function) => {
      mockCtx.cleanup = fn()
    },
  }

  let providersConfig: any = {
    p1: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 7890 },
    p2: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 7891 },
  }

  const config = {
    heartbeatEnabled: { get: () => true },
    heartbeatInterval: { get: () => 60 },
    heartbeatConsecutiveFails: { get: () => 2 },
    localDirect: { get: () => true },
    providers: { get: () => providersConfig },
  }

  apply(mockCtx, config as any)

  // Inject heartbeat states
  mockCtx.providerProxyState.setHeartbeatState('p1', { status: 'healthy', fails: 0, lastCheckAt: Date.now(), latencyMs: 50 })
  mockCtx.providerProxyState.setHeartbeatState('p2', { status: 'unreachable', fails: 2, lastCheckAt: Date.now(), latencyMs: 100 })

  assert.ok(mockCtx.providerProxyState.heartbeat.p1)
  assert.ok(mockCtx.providerProxyState.heartbeat.p2)

  // 1. Disable p2
  providersConfig = {
    p1: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 7890 },
    p2: { enabled: false, protocol: 'http', host: '127.0.0.1', port: 7891 },
  }
  mockCtx.onConfig()
  await new Promise(resolve => setImmediate(resolve))

  assert.ok(mockCtx.providerProxyState.heartbeat.p1, 'p1 preserved')
  assert.equal(mockCtx.providerProxyState.heartbeat.p2, undefined, 'disabled p2 purged from heartbeat')

  // 2. Remove p1
  providersConfig = {}
  mockCtx.onConfig()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(mockCtx.providerProxyState.heartbeat.p1, undefined, 'removed p1 purged from heartbeat')

  await mockCtx.cleanup?.()
})

test('N23: /dsh-provider-proxy/providers endpoint exposes heartbeat state dictionary', async () => {
  let providersHandler: any
  const mockCtx: any = {
    on: () => () => {},
    emit: () => {},
    effect: (fn: Function) => {
      mockCtx.cleanup = fn()
    },
    inject: (deps: string[], fn: Function) => {
      if (deps.includes('webServer')) {
        fn({
          webServer: {
            register: (route: any) => {
              if (route.path === '/dsh-provider-proxy/providers') {
                providersHandler = route.handler
              }
            },
          },
        })
      }
    },
    llm: {
      listProviders: () => [{ id: 'p1', name: 'Provider 1' }],
    },
  }

  const config = {
    heartbeatEnabled: { get: () => true },
    providers: {
      get: () => ({
        p1: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 7890 },
      }),
    },
  }

  apply(mockCtx, config as any)

  assert.ok(providersHandler, 'providers endpoint registered')

  // Set heartbeat state
  mockCtx.providerProxyState.setHeartbeatState('p1', {
    status: 'unreachable',
    lastCheckAt: 12345678,
    latencyMs: 88,
    error: 'ECONNREFUSED',
    fails: 2,
  })

  let body = ''
  const res = {
    writeHead() {},
    end(text: string) {
      body = text
    },
  }

  providersHandler({}, res)
  const json = JSON.parse(body)

  assert.ok(json.heartbeat, 'heartbeat dictionary included in response')
  assert.equal(json.heartbeat.p1.status, 'unreachable')
  assert.equal(json.heartbeat.p1.error, 'ECONNREFUSED')
  assert.equal(json.heartbeat.p1.fails, 2)
  assert.equal(json.heartbeat.p1.latencyMs, 88)

  await mockCtx.cleanup?.()
})
