// The Host half publishes the provider catalogue over a same-origin endpoint,
// because this release has no client-facing LLM service. These tests prove the
// endpoint returns exactly what `ctx.llm` reports.

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

const { apply } = await import('../lib/index.js')

/** Collect the route the plugin registers, and answer it. */
function mountHost(llm, web) {
  const routes = new Map()
  const ctx = new EventEmitter()
  ctx.on = (event, fn, opts) => {
    if (opts?.global) return EventEmitter.prototype.on.call(ctx, event, fn)
    return EventEmitter.prototype.on.call(ctx, event, fn)
  }
  ctx.emit = EventEmitter.prototype.emit.bind(ctx)
  ctx.effect = fn => { fn(); return () => {} }
  ctx.logger = { info() {}, error() {}, warn() {} }
  ctx.llm = llm
  ctx.inject = (services, cb) => {
    if (services.includes('webServer')) {
      cb({ webServer: { register: route => routes.set(route.path, route) } })
    }
    if (services.includes('web') && web !== undefined) {
      cb({ web })
    }
    return () => {}
  }
  const config = { providers: { get: () => ({}) } }
  apply(ctx, config)
  return { ctx, routes, config }
}

function get(routes) {
  const route = routes.get('/dsh-provider-proxy/providers')
  assert.ok(route, 'the plugin must register the provider endpoint')
  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; return res },
    end(text) { chunks.push(text) },
  }
  route.handler({}, res)
  return { status: res.statusCode, body: JSON.parse(chunks.join('')) }
}

test('the endpoint lists live and configurable providers', () => {
  const { routes } = mountHost({
    listProviders: () => [{ id: 'sensenova', name: 'SenseNova' }],
    listConfigurableProviders: () => [
      { provider: 'sensenova', displayName: 'SenseNova' },
      { provider: 'openai', displayName: 'OpenAI' },
    ],
  })
  const { status, body } = get(routes)
  assert.equal(status, 200)
  assert.deepEqual(
    [...body.providers].sort((a, b) => a.id.localeCompare(b.id)),
    [
      { id: 'openai', name: 'OpenAI', live: false },
      { id: 'sensenova', name: 'SenseNova', live: true },
    ],
  )
  assert.deepEqual(body.hits, {}, 'no request has been routed yet')
})

test('a live web service publishes the reserved web-search row', () => {
  const { routes } = mountHost(
    { listProviders: () => [{ id: 'sensenova', name: 'SenseNova' }], listConfigurableProviders: () => [] },
    { search: async () => ({ sources: [], truncated: false }) },
  )
  const { body } = get(routes)
  assert.ok(
    body.providers.some(row => row.id === 'web-search' && row.name === 'Web 搜索' && row.live === true),
    'the reserved web-search row must be published when the web service exists',
  )
})

test('a composition without a web service publishes no web-search row', () => {
  const { routes } = mountHost({ listProviders: () => [], listConfigurableProviders: () => [] })
  const { body } = get(routes)
  assert.ok(!body.providers.some(row => row.id === 'web-search'), 'nothing to route, so no card')
})

test('a live route with no configurable entry is still listed', () => {
  const { routes } = mountHost({
    listProviders: () => [{ id: 'opencode2dsh', name: 'OpenCode' }],
    listConfigurableProviders: () => [],
  })
  const { body } = get(routes)
  assert.deepEqual(body.providers, [{ id: 'opencode2dsh', name: 'OpenCode', live: true }])
})

test('a missing displayName falls back to the route id', () => {
  const { routes } = mountHost({
    listProviders: () => [],
    listConfigurableProviders: () => [{ provider: 'acme', displayName: '' }],
  })
  const { body } = get(routes)
  assert.deepEqual(body.providers, [{ id: 'acme', name: 'acme', live: false }])
})

test('a composition without an llm service still answers, with an empty list', () => {
  const { routes } = mountHost({})
  const { status, body } = get(routes)
  assert.equal(status, 200)
  assert.deepEqual(body.providers, [])
})

test('a throwing llm service does not break the endpoint', () => {
  const { routes } = mountHost({
    listProviders: () => { throw new Error('boom') },
    listConfigurableProviders: () => { throw new Error('boom') },
  })
  const { status, body } = get(routes)
  assert.equal(status, 200)
  assert.deepEqual(body.providers, [])
})

test('the Host half never mutates its config object', () => {
  // An earlier version wrote `config.catalog = …`, which broke Desktop boot.
  const { config } = mountHost({
    listProviders: () => [{ id: 'sensenova', name: 'SenseNova' }],
    listConfigurableProviders: () => [],
  })
  assert.deepEqual(Object.keys(config), ['providers'])
  assert.equal(typeof config.providers.get, 'function', 'the volatile reference is untouched')
})
