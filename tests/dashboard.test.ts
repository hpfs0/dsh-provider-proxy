import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  calculateCoverage,
  calculateObservabilityMetrics,
  calculateTotalHits,
  calculateTrafficSplit,
  formatNumber,
  countUnreachableProviders,
  apply,
} from '../lib/index.js'

const NOW = new Date('2026-11-17T12:00:00.000Z').getTime()
const HOUR = 60 * 60 * 1000

test('formatNumber formats numbers with thousands commas', () => {
  assert.equal(formatNumber(0), '0')
  assert.equal(formatNumber(-5), '0')
  assert.equal(formatNumber(999), '999')
  assert.equal(formatNumber(1000), '1,000')
  assert.equal(formatNumber(100000), '100,000')
  assert.equal(formatNumber(12345678), '12,345,678')
})

test('calculateCoverage computes proxy coverage across empty, partial and full sets', () => {
  // Empty
  const empty = calculateCoverage([], {})
  assert.equal(empty.proxied, 0)
  assert.equal(empty.active, 0)
  assert.equal(empty.formatted, '0 / 0 活跃')

  // English formatting
  const emptyEn = calculateCoverage([], {}, {}, false)
  assert.equal(emptyEn.formatted, '0 / 0 Active')

  // Rows without live marker use total length
  const rows = [
    { id: 'p1', name: 'P1', live: true },
    { id: 'p2', name: 'P2', live: true },
    { id: 'p3', name: 'P3', live: false },
  ]
  const configured = {
    p1: { enabled: true },
    p2: { enabled: false },
    p3: { enabled: true },
  }
  const cov1 = calculateCoverage(rows, configured)
  assert.equal(cov1.active, 2, 'only live: true count towards active when some are live')
  assert.equal(cov1.proxied, 2, 'p1 and p3 are enabled')
  assert.equal(cov1.formatted, '2 / 2 活跃')

  // Problem-rejected provider does not count as proxied
  const problems = { p1: 'Bad port' }
  const cov2 = calculateCoverage(rows, configured, problems)
  assert.equal(cov2.proxied, 1, 'rejected p1 must not count as proxied')
  assert.equal(cov2.formatted, '1 / 2 活跃')
})

test('P3-f: proxy success rate uses only completed probes inside the 24h window', () => {
  // Empty lastUse
  const empty = calculateObservabilityMetrics({ now: NOW })
  assert.equal(empty.rate, 100)
  assert.equal(empty.formatted, '100% 成功')

  // In-flight only (no completion) is not a completed probe.
  const inFlightOnly = calculateObservabilityMetrics({
    now: NOW,
    lastUse: { p1: { startedAt: NOW - HOUR } },
  })
  assert.equal(inFlightOnly.rate, 100)
  assert.equal(inFlightOnly.formatted, '100% 成功')

  // All success
  const allOk = calculateObservabilityMetrics({
    now: NOW,
    lastUse: {
      p1: { ok: true, at: NOW - HOUR },
      p2: { ok: true, at: NOW - 2 * HOUR },
    },
  })
  assert.equal(allOk.rate, 100)
  assert.equal(allOk.formatted, '100% 成功')

  // All failed
  const allFailed = calculateObservabilityMetrics({
    now: NOW,
    lastUse: {
      p1: { ok: false, at: NOW - HOUR, code: 'ECONNREFUSED' },
      p2: { ok: false, at: NOW - 2 * HOUR, code: 'TIMEOUT' },
    },
  })
  assert.equal(allFailed.rate, 0)
  assert.equal(allFailed.formatted, '0% 成功')

  // Partial success (3 ok, 1 fail = 75%)
  const partial = calculateObservabilityMetrics({
    now: NOW,
    lastUse: {
      p1: { ok: true, at: NOW - 60_000 },
      p2: { ok: true, at: NOW - 2 * HOUR },
      p3: { ok: true, at: NOW - 3 * HOUR },
      p4: { ok: false, at: NOW - 4 * HOUR },
    },
  })
  assert.equal(partial.rate, 75)
  assert.equal(partial.formatted, '75% 成功')

  // Decimal rate (e.g. 2 ok, 1 fail = 66.7%)
  const decimal = calculateObservabilityMetrics({
    now: NOW,
    lastUse: {
      p1: { ok: true, at: NOW - 60_000 },
      p2: { ok: true, at: NOW - 2 * HOUR },
      p3: { ok: false, at: NOW - 3 * HOUR },
    },
  })
  assert.equal(decimal.rate, 66.7)
  assert.equal(decimal.formatted, '66.7% 成功')

  // English
  const decimalEn = calculateObservabilityMetrics({
    now: NOW,
    lastUse: {
      p1: { ok: true, at: NOW - 60_000 },
      p2: { ok: false, at: NOW - 2 * HOUR },
    },
    isZh: false,
  })
  assert.equal(decimalEn.formatted, '50% Success')
})

test('P3-f: success rate excludes stale and undated records', () => {
  const metrics = calculateObservabilityMetrics({
    now: NOW,
    lastUse: {
      freshOk: { ok: true, at: NOW - 23 * HOUR },
      boundaryFail: { ok: false, at: NOW - 24 * HOUR },
      staleOk: { ok: true, at: NOW - 24 * HOUR - 1 },
      undatedOk: { ok: true },
      unfinished: { startedAt: NOW - HOUR },
    },
  })
  assert.equal(metrics.successes, 1)
  assert.equal(metrics.total, 2)
  assert.equal(metrics.rate, 50)
  assert.equal(metrics.formatted, '50% 成功')
})

test('P3-f: self-check results count as success probes inside the same window', () => {
  const metrics = calculateObservabilityMetrics({
    now: NOW,
    tests: {
      good: { ok: true, at: NOW - HOUR },
      bad: { ok: false, at: NOW - 2 * HOUR },
      stale: { ok: true, at: NOW - 25 * HOUR },
      undated: { ok: true },
      pending: { pending: true, at: NOW - HOUR },
    },
  })
  assert.equal(metrics.successes, 1)
  assert.equal(metrics.total, 2)
  assert.equal(metrics.rate, 50)
})

test('P3-f: heartbeat probes count as success probes inside the same window', () => {
  const metrics = calculateObservabilityMetrics({
    now: NOW,
    heartbeat: {
      healthy: {
        status: 'healthy',
        lastCheckAt: NOW - 30 * 60_000,
        lastSuccessAt: NOW - 30 * 60_000,
      },
      failed: {
        status: 'unreachable',
        lastCheckAt: NOW - 2 * HOUR,
      },
      staleHealthy: {
        status: 'healthy',
        lastCheckAt: NOW - 25 * HOUR,
        lastSuccessAt: NOW - 25 * HOUR,
      },
    },
  })
  assert.equal(metrics.successes, 1)
  assert.equal(metrics.total, 2)
  assert.equal(metrics.rate, 50)
})

test('P3-f: average latency combines proxy results, self-checks and heartbeat probes', () => {
  // Empty
  const empty = calculateObservabilityMetrics({ now: NOW })
  assert.equal(empty.averageMs, null)
  assert.equal(empty.latencyFormatted, '- ms')

  // Invalid or <= 0
  const invalid = calculateObservabilityMetrics({
    now: NOW,
    lastUse: {
      p1: { ok: true, at: NOW - HOUR, ms: 0 },
      p2: { ok: true, at: NOW - HOUR, ms: -10 },
    },
  })
  assert.equal(invalid.averageMs, null)
  assert.equal(invalid.latencyFormatted, '- ms')

  // Valid values
  const valid = calculateObservabilityMetrics({
    now: NOW,
    lastUse: {
      p1: { ok: true, at: NOW - HOUR, ms: 120 },
      p2: { ok: true, at: NOW - HOUR, ms: 240 },
      p3: { ok: true, at: NOW - HOUR, ms: 360 },
    },
  })
  assert.equal(valid.averageMs, 240)
  assert.equal(valid.latencyFormatted, '240 ms')

  // Mixed valid and invalid
  const mixed = calculateObservabilityMetrics({
    now: NOW,
    lastUse: {
      p1: { ok: true, at: NOW - HOUR, ms: 150 },
      p2: { ok: true, at: NOW - HOUR, ms: 0 },
      p3: { ok: true, at: NOW - HOUR, ms: 250 },
    },
  })
  assert.equal(mixed.averageMs, 200)
  assert.equal(mixed.latencyFormatted, '200 ms')

  // All three sources contribute to the same average; stale samples do not.
  const combined = calculateObservabilityMetrics({
    now: NOW,
    lastUse: {
      proxy: { ok: true, at: NOW - HOUR, ms: 100 },
    },
    tests: {
      selfCheck: { ok: true, at: NOW - 2 * HOUR, ms: 200 },
      staleSelfCheck: { ok: true, at: NOW - 25 * HOUR, ms: 10_000 },
    },
    heartbeat: {
      probe: {
        status: 'healthy',
        lastCheckAt: NOW - 30 * 60_000,
        lastSuccessAt: NOW - 30 * 60_000,
        latencyMs: 300,
      },
      staleProbe: {
        status: 'healthy',
        lastCheckAt: NOW - 25 * HOUR,
        lastSuccessAt: NOW - 25 * HOUR,
        latencyMs: 10_000,
      },
    },
  })
  assert.equal(combined.averageMs, 200)
  assert.equal(combined.latencyFormatted, '200 ms')
})

test('calculateTotalHits sums all valid positive hits', () => {
  assert.equal(calculateTotalHits({}).total, 0)
  assert.equal(calculateTotalHits({}).formatted, '0')

  assert.equal(
    calculateTotalHits({
      p1: 1500,
      p2: 2500,
      p3: -10,
    }).formatted,
    '4,000',
  )

  assert.equal(
    calculateTotalHits({
      deepseek: 100000,
      openai: 250500,
    }).formatted,
    '350,500',
  )
})

test('N19: reset-hits endpoint clears hits counter on Host', async () => {
  const routes = new Map<string, any>()
  const ctx = new EventEmitter() as any
  ctx.on = (event: string, fn: any) => EventEmitter.prototype.on.call(ctx, event, fn)
  ctx.effect = (fn: any) => fn()
  ctx.inject = (services: string[], cb: any) => {
    if (services.includes('webServer')) {
      cb({ webServer: { register: (r: any) => routes.set(r.path, r) } })
    }
  }

  const config = {
    providers: {
      get: () => ({
        p1: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 8080 },
      }),
    },
  }

  apply(ctx, config as any)

  // Verify reset-hits endpoint registered
  const resetRoute = routes.get('/dsh-provider-proxy/reset-hits')
  assert.ok(resetRoute, 'reset-hits endpoint registered')

  // Simulate hits via internal state
  ctx.providerProxyState.hits.p1 = 42

  // Call reset-hits
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status: number, headers: any) {
      this.statusCode = status
      this.headers = headers
      return this
    },
    end() {},
  }

  resetRoute.handler({}, res)
  assert.equal(res.statusCode, 200)

  // Verify hits cleared
  const providersRoute = routes.get('/dsh-provider-proxy/providers')
  let providersJson = ''
  const pres = {
    writeHead() {},
    end(text: string) {
      providersJson = text
    },
  }
  providersRoute.handler({}, pres)
  const body = JSON.parse(providersJson)
  assert.deepEqual(body.hits, {}, 'hits must be empty after reset')
})

test('N23: countUnreachableProviders counts only enabled unreachable routes', () => {
  // 1. Empty case
  const empty = countUnreachableProviders([], {})
  assert.equal(empty.count, 0)
  assert.deepEqual(empty.unreachableIds, [])

  const rows = [
    { id: 'p1', name: 'Provider 1', live: true },
    { id: 'p2', name: 'Provider 2', live: true },
    { id: 'p3', name: 'Provider 3', live: true },
    { id: 'p4', name: 'Provider 4', live: false },
  ]

  const configured = {
    p1: { enabled: true },
    p2: { enabled: false }, // disabled route
    p3: { enabled: true },
    p4: { enabled: true },
  }

  // 2. All healthy or no heartbeat records
  const resHealthy = countUnreachableProviders(rows, configured, {
    p1: { status: 'healthy', fails: 0 },
    p2: { status: 'healthy', fails: 0 },
    p3: { status: 'healthy', fails: 0 },
  })
  assert.equal(resHealthy.count, 0)
  assert.deepEqual(resHealthy.unreachableIds, [])

  // 3. Unreachable states mixed with disabled and unconfigured
  const resUnreachable = countUnreachableProviders(rows, configured, {
    p1: { status: 'unreachable', error: 'ECONNREFUSED', fails: 2 },
    p2: { status: 'unreachable', error: 'TIMEOUT', fails: 3 }, // disabled -> MUST NOT count
    p3: { status: 'healthy', fails: 0 },
    p4: { status: 'unreachable', error: 'EHOSTUNREACH', fails: 2 },
    pUnknown: { status: 'unreachable', fails: 5 }, // not in rows -> MUST NOT count
  })
  assert.equal(resUnreachable.count, 2)
  assert.deepEqual(resUnreachable.unreachableIds, ['p1', 'p4'])
})

test('N24: calculateTrafficSplit classifies forwarded requests without inventing any', () => {
  // Nothing has run yet: both halves are zero and the total still agrees.
  const empty = calculateTrafficSplit({}, undefined)
  assert.deepEqual(empty, {
    total: 0,
    reasoning: 0,
    search: 0,
    directSearch: 0,
    formatted: '推理 0 · 搜索 0',
  })

  // The halves ADD UP to the total the other metric shows.
  const split = calculateTrafficSplit({ deepseek: 7, sensenova: 2, 'web-search': 3 }, { direct: 1 })
  assert.equal(split.total, 12)
  assert.equal(split.search, 3)
  assert.equal(split.reasoning, 9)
  assert.equal(split.directSearch, 1)
  assert.equal(split.formatted, '推理 9 · 搜索 3（直连 1）')

  // No reserved route in the map at all: everything is reasoning.
  const reasoningOnly = calculateTrafficSplit({ deepseek: 4 }, undefined)
  assert.equal(reasoningOnly.search, 0)
  assert.equal(reasoningOnly.reasoning, 4)
  assert.equal(reasoningOnly.formatted, '推理 4 · 搜索 0')

  // A direct-only search strategy still reports the direct calls separately
  // instead of folding them into a proxied count they never earned.
  const directOnly = calculateTrafficSplit({}, { direct: 5 })
  assert.equal(directOnly.total, 0)
  assert.equal(directOnly.search, 0)
  assert.equal(directOnly.formatted, '推理 0 · 搜索 0（直连 5）')

  // English wording, and a search count larger than the map's total (a reset
  // raced a poll) must never produce a negative reasoning count.
  assert.equal(calculateTrafficSplit({}, undefined, false).formatted, 'Reasoning 0 · Search 0')
  const clamped = calculateTrafficSplit({ 'web-search': 3 }, undefined, false)
  assert.equal(clamped.reasoning, 0, 'a negative reasoning count is clamped, not rendered')
  assert.equal(clamped.search, 3)

  // Garbage in the map is ignored rather than formatted as NaN.
  const garbage = calculateTrafficSplit({ 'web-search': Number.NaN }, { direct: Number.NaN })
  assert.equal(garbage.search, 0)
  assert.equal(garbage.directSearch, 0)
  assert.equal(garbage.formatted, '推理 0 · 搜索 0')
})
