import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import {
  calculateCoverage,
  calculateSuccessRate,
  calculateAverageLatency,
  calculateTotalHits,
  formatNumber,
  apply,
} from '../lib/index.js'

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
  assert.equal(empty.formatted, '已代理 0 / 活跃共 0')

  // English formatting
  const emptyEn = calculateCoverage([], {}, {}, false)
  assert.equal(emptyEn.formatted, 'Proxied 0 / 0 Active')

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
  assert.equal(cov1.formatted, '已代理 2 / 活跃共 2')

  // Problem-rejected provider does not count as proxied
  const problems = { p1: 'Bad port' }
  const cov2 = calculateCoverage(rows, configured, problems)
  assert.equal(cov2.proxied, 1, 'rejected p1 must not count as proxied')
  assert.equal(cov2.formatted, '已代理 1 / 活跃共 2')
})

test('calculateSuccessRate computes percentage correctly across edge cases', () => {
  // Empty lastUse
  const empty = calculateSuccessRate({})
  assert.equal(empty.rate, 100)
  assert.equal(empty.formatted, '100% 成功')

  // In-flight only (no ok)
  const inFlightOnly = calculateSuccessRate({ p1: { startedAt: 123 } })
  assert.equal(inFlightOnly.rate, 100)
  assert.equal(inFlightOnly.formatted, '100% 成功')

  // All success
  const allOk = calculateSuccessRate({
    p1: { ok: true, at: 100 },
    p2: { ok: true, at: 200 },
  })
  assert.equal(allOk.rate, 100)
  assert.equal(allOk.formatted, '100% 成功')

  // All failed
  const allFailed = calculateSuccessRate({
    p1: { ok: false, code: 'ECONNREFUSED' },
    p2: { ok: false, code: 'TIMEOUT' },
  })
  assert.equal(allFailed.rate, 0)
  assert.equal(allFailed.formatted, '0% 成功')

  // Partial success (3 ok, 1 fail = 75%)
  const partial = calculateSuccessRate({
    p1: { ok: true },
    p2: { ok: true },
    p3: { ok: true },
    p4: { ok: false },
  })
  assert.equal(partial.rate, 75)
  assert.equal(partial.formatted, '75% 成功')

  // Decimal rate (e.g. 2 ok, 1 fail = 66.7%)
  const decimal = calculateSuccessRate({
    p1: { ok: true },
    p2: { ok: true },
    p3: { ok: false },
  })
  assert.equal(decimal.rate, 66.7)
  assert.equal(decimal.formatted, '66.7% 成功')

  // English
  const decimalEn = calculateSuccessRate({
    p1: { ok: true },
    p2: { ok: false },
  }, false)
  assert.equal(decimalEn.formatted, '50% Success')
})

test('calculateAverageLatency averages valid tests and handles empty cases', () => {
  // Empty
  const empty = calculateAverageLatency({})
  assert.equal(empty.averageMs, null)
  assert.equal(empty.formatted, '- ms')

  // Invalid or <= 0
  const invalid = calculateAverageLatency({
    p1: { ms: 0 },
    p2: { ms: -10 },
    p3: {},
  })
  assert.equal(invalid.averageMs, null)
  assert.equal(invalid.formatted, '- ms')

  // Valid values
  const valid = calculateAverageLatency({
    p1: { ms: 120 },
    p2: { ms: 240 },
    p3: { ms: 360 },
  })
  assert.equal(valid.averageMs, 240)
  assert.equal(valid.formatted, '240 ms')

  // Mixed valid and invalid
  const mixed = calculateAverageLatency({
    p1: { ms: 150 },
    p2: { ms: 0 },
    p3: { ms: 250 },
  })
  assert.equal(mixed.averageMs, 200)
  assert.equal(mixed.formatted, '200 ms')
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
