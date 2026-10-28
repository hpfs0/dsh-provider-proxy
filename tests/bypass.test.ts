import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  apply,
  buildDecide,
  createProxyTable,
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
    url: `http://127.0.0.1:${port}/upstream`,
    getHits: () => hits,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

async function startRecordingProxy() {
  const seen: { host?: string; url?: string }[] = []
  const server = createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ via: 'proxy' }))
  })
  server.on('connect', (req, socket) => {
    seen.push({ host: '(tunnel)', url: req.url })
    socket.on('error', () => {})
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    seen,
    port,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

test('N20: buildDecide returns constant direct when bypassAll is true', () => {
  const route = {
    enabled: true,
    profileId: '',
    useDefault: false,
    protocol: 'http' as const,
    host: '127.0.0.1',
    port: 8080,
    username: '',
    password: '',
    onlyHosts: 'api.deepseek.com, api.openai.com',
    bypassHosts: '',
    testTarget: '',
  }

  // Normal mode: matches onlyHosts -> proxy; doesn't match -> direct
  const normalDecide = buildDecide(route, true, false)
  assert.equal(normalDecide('api.deepseek.com'), 'proxy')
  assert.equal(normalDecide('other.com'), 'direct')
  assert.equal(normalDecide(undefined), 'proxy') // fail-closed

  // Emergency bypass all mode: ALWAYS direct
  const bypassDecide = buildDecide(route, true, true)
  assert.equal(bypassDecide('api.deepseek.com'), 'direct', 'target in onlyHosts still goes direct')
  assert.equal(bypassDecide('other.com'), 'direct')
  assert.equal(bypassDecide('localhost'), 'direct')
  assert.equal(bypassDecide(undefined), 'direct', 'undefined host also stays direct in bypass mode')
})

test('N20: createProxyTable applies bypassAll to all built route entries', () => {
  const config = {
    p1: {
      enabled: true,
      protocol: 'http' as const,
      host: '127.0.0.1',
      port: 8080,
    },
    p2: {
      enabled: true,
      protocol: 'http' as const,
      host: '127.0.0.1',
      port: 8081,
    },
  }

  const normalTable = createProxyTable(config, { bypassAll: false })
  assert.equal(normalTable.entries.get('p1')?.decide('example.com'), 'proxy')
  assert.equal(normalTable.entries.get('p2')?.decide('example.com'), 'proxy')

  const bypassTable = createProxyTable(config, { bypassAll: true })
  assert.equal(bypassTable.entries.get('p1')?.decide('example.com'), 'direct')
  assert.equal(bypassTable.entries.get('p2')?.decide('example.com'), 'direct')
})

test('N20: apply() with emergency bypass all routes traffic direct without modifying configs', async () => {
  const origin = await startOriginServer()
  const proxy = await startRecordingProxy()

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
      listProviders: () => [{ id: 'provider-1', name: 'Provider 1' }],
    },
  }

  let bypassState = true
  const config = {
    providers: {
      get: () => ({
        'provider-1': {
          enabled: true,
          protocol: 'http',
          host: '127.0.0.1',
          port: proxy.port,
          localDirect: false, // forces proxy unless bypassed
        },
      }),
    },
    bypassAll: {
      get: () => bypassState,
    },
    localDirect: {
      get: () => false,
    },
  }

  apply(mockCtx, config)

  const streamListener = listeners.find(l => l.event === 'llm/stream')
  assert.ok(streamListener, 'stream listener registered')

  // Phase 1: bypassAll is true
  const stream1 = streamListener.fn(
    { provider: 'provider-1' },
    () =>
      (async function* () {
        await new Promise(resolve => setImmediate(resolve))
        const res = await fetch(origin.url)
        yield await res.json()
      })(),
  )

  const chunks1 = []
  for await (const chunk of stream1) chunks1.push(chunk)

  assert.equal(chunks1.length, 1)
  assert.equal((chunks1[0] as any).origin, true)
  assert.equal(proxy.seen.length, 0, 'bypassed request must never cross the proxy')
  assert.equal(mockCtx.providerProxyState.hits['provider-1'] ?? 0, 0, 'bypassed request is not counted in hits')
  assert.equal(mockCtx.providerProxyState.bypassAll, true, 'state reports bypassAll: true')

  // Phase 2: toggle bypassAll off
  bypassState = false
  const volatileListener = listeners.find(l => l.event === 'loader/volatile-update')
  if (volatileListener) {
    volatileListener.fn()
  }

  // Let rebuild settle
  await new Promise(resolve => setImmediate(resolve))

  const stream2 = streamListener.fn(
    { provider: 'provider-1' },
    () =>
      (async function* () {
        await new Promise(resolve => setImmediate(resolve))
        const res = await fetch(origin.url)
        yield await res.json()
      })(),
  )

  const chunks2 = []
  for await (const chunk of stream2) chunks2.push(chunk)

  assert.equal(chunks2.length, 1)
  assert.equal(proxy.seen.length, 1, 'when bypass is off, request crosses the proxy')
  assert.equal(mockCtx.providerProxyState.hits['provider-1'], 1, 'routed request is counted')
  assert.equal(mockCtx.providerProxyState.bypassAll, false, 'state reports bypassAll: false')

  // Config is completely untouched
  const currentConfig = config.providers.get()['provider-1']
  assert.equal(currentConfig.enabled, true, 'provider remains enabled')
  assert.equal(currentConfig.port, proxy.port, 'proxy port preserved')

  await proxy.close()
  await origin.close()
})
