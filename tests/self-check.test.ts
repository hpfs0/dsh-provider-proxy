// The connection self-check proves a provider's proxy actually carries a request.
// Its whole point is to eliminate FALSE POSITIVES, so these tests pin the two ways
// it could lie: an unreachable proxy must FAIL rather than report success, and a
// passing check must have really crossed the proxy instead of going direct.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'

const { apply } = await import('../lib/index.js')

/** A fake forward proxy that answers with an IP echo, optionally after a delay. */
async function startEchoProxy(delayMs = 0) {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, method: req.method })
    const reply = () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ip: '203.0.113.9' }))
    }
    if (delayMs > 0) setTimeout(reply, delayMs)
    else reply()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { seen, port, close: () => new Promise(resolve => server.close(resolve)) }
}

/** Mount the Host half with a webServer mock, as the shipped composition does. */
function mountHost(config) {
  const routes = new Map()
  const ctx = new EventEmitter()
  ctx.on = (event, fn) => EventEmitter.prototype.on.call(ctx, event, fn)
  ctx.emit = EventEmitter.prototype.emit.bind(ctx)
  ctx.effect = fn => { fn(); return () => {} }
  ctx.logger = { info() {}, error() {}, warn() {} }
  ctx.llm = { listProviders: () => [], listConfigurableProviders: () => [] }
  ctx.inject = (services, cb) => {
    if (services.includes('webServer')) {
      cb({ webServer: { register: route => routes.set(route.path, route) } })
    }
    return () => {}
  }
  apply(ctx, config)
  return { routes }
}

/** POST the self-check endpoint and resolve its JSON reply. */
function selfCheck(routes, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const route = routes.get('/dsh-provider-proxy/test')
    assert.ok(route, 'the plugin must register the self-check endpoint')
    const payload = Buffer.from(JSON.stringify(body))
    const req = new EventEmitter()
    req.method = method
    const res = {
      statusCode: 0,
      writeHead(status) { res.statusCode = status; return res },
      end(text) {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(text) })
        } catch (error) {
          reject(error)
        }
      },
    }
    route.handler(req, res)
    // Deliver the body exactly as a real request stream would, AFTER the handler
    // has attached its listeners.
    setImmediate(() => {
      req.emit('data', payload)
      req.emit('end')
    })
  })
}

const oneRoute = (port) => ({
  providers: { get: () => ({ p: { enabled: true, protocol: 'http', host: '127.0.0.1', port } }) },
  testUrl: 'http://echo.invalid/ip',
})

test('a reachable proxy reports ok with latency and the exit IP', async () => {
  const proxy = await startEchoProxy()
  try {
    const { routes } = mountHost(oneRoute(proxy.port))
    const { status, body } = await selfCheck(routes, { provider: 'p' })
    assert.equal(status, 200)
    assert.equal(body.ok, true, 'the proxy carried the request')
    assert.equal(body.exitIp, '203.0.113.9')
    assert.equal(typeof body.ms, 'number')
    assert.equal(proxy.seen.length, 1, 'the request really crossed the proxy')
    assert.equal(proxy.seen[0].url, 'http://echo.invalid/ip', 'the proxy saw the absolute-form target')
  } finally {
    await proxy.close()
  }
})

test('an unreachable proxy FAILS instead of reporting a false success', async () => {
  // Nothing listens on port 1: the check must name the proxy hop, never pass.
  const { routes } = mountHost(oneRoute(1))
  const { body } = await selfCheck(routes, { provider: 'p' })
  assert.equal(body.ok, false)
  assert.equal(body.kind, 'proxy-unreachable')
})

test('a provider with no live route is reported, not tested', async () => {
  const { routes } = mountHost({ providers: { get: () => ({}) }, testUrl: 'http://echo.invalid/ip' })
  const { status, body } = await selfCheck(routes, { provider: 'missing' })
  assert.equal(status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.kind, 'no-route')
})

// A route that is enabled but REJECTED by a guard (here: an HTTP password with
// no username) is absent from the live table too. Reporting "not enabled" for it
// names the wrong cause — the setting IS on — and the whole point of the check is
// to point at the hop that actually failed.
test('a route rejected by validation reports the recorded problem', async () => {
  const { routes } = mountHost({
    providers: {
      get: () => ({
        p: {
          enabled: true,
          protocol: 'http',
          host: '127.0.0.1',
          port: 7890,
          username: '',
          password: 'secret',
        },
      }),
    },
    testUrl: 'http://echo.invalid/ip',
  })
  const { status, body } = await selfCheck(routes, { provider: 'p' })
  assert.equal(status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.kind, 'route-rejected')
  assert.match(body.error, /没有用户名/, 'the report must name the cause the table recorded')
  assert.ok(
    !body.error.includes('dsh-provider-proxy:'),
    'the Host-log prefix is noise on a card and must not reach the page',
  )
})

test('the endpoint refuses anything but POST', async () => {
  const { routes } = mountHost({ providers: { get: () => ({}) }, testUrl: 'http://echo.invalid/ip' })
  const { status, body } = await selfCheck(routes, { provider: 'p' }, 'GET')
  assert.equal(status, 405)
  assert.equal(body.kind, 'method')
})

test('concurrent checks for one provider share a single outbound request', async () => {
  const proxy = await startEchoProxy(60)
  try {
    const { routes } = mountHost(oneRoute(proxy.port))
    const [first, second] = await Promise.all([
      selfCheck(routes, { provider: 'p' }),
      selfCheck(routes, { provider: 'p' }),
    ])
    assert.equal(first.body.ok, true)
    assert.equal(second.body.ok, true)
    assert.equal(proxy.seen.length, 1, 'a repeated click must not multiply outbound requests')
  } finally {
    await proxy.close()
  }
})
