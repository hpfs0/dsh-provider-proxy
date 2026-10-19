// The connection self-check proves a provider's proxy actually carries a request.
// Its whole point is to eliminate FALSE POSITIVES, so these tests pin the two ways
// it could lie: an unreachable proxy must FAIL rather than report success, and a
// passing check must have really crossed the proxy instead of going direct.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { ProxyAgent } from 'undici'

const { apply } = await import('../lib/index.js')

/** A fake forward proxy that answers with an IP echo, optionally after a delay. */
async function startEchoProxy(delayMs = 0, status = 200) {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, method: req.method })
    const reply = () => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(status === 200 ? JSON.stringify({ ip: '203.0.113.9' }) : JSON.stringify({ error: 'nope' }))
    }
    if (delayMs > 0) setTimeout(reply, delayMs)
    else reply()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { seen, port, close: () => new Promise(resolve => server.close(resolve)) }
}

/**
 * Mount the Host half with a webServer mock, as the shipped composition does.
 *
 * `extras.settings` / `extras.configurable` stand in for the settings service and
 * the adapter directory that a real composition provides; omitting both is the
 * "no integration available" case.
 */
function mountHost(config, extras = {}) {
  const routes = new Map()
  const ctx = new EventEmitter()
  ctx.on = (event, fn) => EventEmitter.prototype.on.call(ctx, event, fn)
  ctx.emit = EventEmitter.prototype.emit.bind(ctx)
  ctx.effect = fn => { fn(); return () => {} }
  ctx.logger = { info() {}, error() {}, warn() {} }
  ctx.llm = {
    listProviders: () => [],
    listConfigurableProviders: () => extras.configurable ?? [],
  }
  // Cordis's NON-throwing optional lookup: an absent service reads as undefined
  // rather than throwing, which is what lets the check degrade to `testUrl`.
  ctx.get = name => (name === 'settings' ? extras.settings : undefined)
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
    assert.equal(body.viaProxy, true, 'a non-local target is probed through the proxy')
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

test('an oversized body is refused instead of buffered', async () => {
  const { routes } = mountHost({ providers: { get: () => ({}) }, testUrl: 'http://echo.invalid/ip' })
  const { status, body } = await selfCheck(routes, { provider: 'p', pad: 'x'.repeat(16 * 1024) })
  assert.equal(status, 413)
  assert.equal(body.ok, false)
  assert.equal(body.kind, 'body')
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

// The in-flight dedup only merges CONCURRENT checks; without a cooldown, a slow
// echo target could be hammered serially by repeated clicks. A click inside the
// cooldown gets the remembered answer back — the truth about an unchanged
// configuration, marked cached — instead of a new outbound request.
test('a completed check is answered from the cooldown without a new outbound request', async () => {
  const proxy = await startEchoProxy()
  try {
    const { routes } = mountHost(oneRoute(proxy.port))
    const first = await selfCheck(routes, { provider: 'p' })
    assert.equal(first.body.cached, undefined, 'a fresh check is not marked cached')
    const second = await selfCheck(routes, { provider: 'p' })
    assert.equal(second.body.cached, true, 'a click inside the cooldown is answered from memory')
    assert.equal(second.body.ok, true)
    assert.equal(second.body.exitIp, '203.0.113.9')
    assert.equal(proxy.seen.length, 1, 'no second outbound request was made')
  } finally {
    await proxy.close()
  }
})

// A route's own testTarget wins over the top-level testUrl: pointing the check
// at the provider's REAL upstream proves the end-to-end path, not just the
// proxy hop.
test('a provider testTarget overrides the top-level testUrl', async () => {
  const proxy = await startEchoProxy()
  try {
    const { routes } = mountHost({
      providers: {
        get: () => ({
          p: {
            enabled: true,
            protocol: 'http',
            host: '127.0.0.1',
            port: proxy.port,
            testTarget: 'http://echo.invalid/upstream',
          },
        }),
      },
      testUrl: 'http://echo.invalid/ip',
    })
    const { body } = await selfCheck(routes, { provider: 'p' })
    assert.equal(body.ok, true)
    assert.equal(proxy.seen[0].url, 'http://echo.invalid/upstream', 'the check used the route target, not the global testUrl')
  } finally {
    await proxy.close()
  }
})

// testTarget never touches routing, so a typo must not reject the route — it
// only fails the check, and names the bad value instead of the proxy hop.
test('an unparsable testTarget fails the check without rejecting the route', async () => {
  const proxy = await startEchoProxy()
  try {
    const { routes } = mountHost({
      providers: {
        get: () => ({
          p: {
            enabled: true,
            protocol: 'http',
            host: '127.0.0.1',
            port: proxy.port,
            testTarget: 'not a url',
          },
        }),
      },
      testUrl: 'http://echo.invalid/ip',
    })
    const { body } = await selfCheck(routes, { provider: 'p' })
    assert.equal(body.ok, false)
    assert.equal(body.kind, 'target')
    assert.match(body.error, /自检目标/, 'the report must name the misconfigured field')
    assert.equal(proxy.seen.length, 0, 'nothing was sent for an unparsable target')
  } finally {
    await proxy.close()
  }
})

// ---- checking a route BEFORE it is switched on ----

/** A disabled route pointing at a fake proxy: configured, but not in the live table. */
const disabledRoute = (port) => ({
  providers: {
    get: () => ({ p: { enabled: false, protocol: 'http', host: '127.0.0.1', port } }),
  },
  testUrl: 'http://echo.invalid/ip',
})

test('a configured but disabled route can be checked before it is switched on', async () => {
  const proxy = await startEchoProxy()
  try {
    const { routes } = mountHost(disabledRoute(proxy.port))
    const { status, body } = await selfCheck(routes, { provider: 'p' })
    assert.equal(status, 200)
    assert.equal(body.ok, true, 'the check must build the disabled route for one request')
    assert.equal(body.exitIp, '203.0.113.9')
    assert.equal(proxy.seen.length, 1, 'the request really crossed the proxy')
  } finally {
    await proxy.close()
  }
})

test('the dispatcher built for a disabled route is released, never leaked', async () => {
  const proxy = await startEchoProxy()
  // Count DISTINCT dispatchers, not calls: undici's `ProxyAgent.close()` re-enters
  // its own `close` once (it closes the inner agent through the same method), so
  // a call counter reads 2 for a single, correctly-closed dispatcher.
  const closed = new Set()
  const originalClose = ProxyAgent.prototype.close
  // Node runs each test FILE in its own process, so this spy is confined here.
  ProxyAgent.prototype.close = function patchedClose(...args) {
    closed.add(this)
    return originalClose.apply(this, args)
  }
  try {
    const { routes } = mountHost(disabledRoute(proxy.port))
    await selfCheck(routes, { provider: 'p' })
    assert.equal(
      closed.size,
      1,
      'exactly one dispatcher was built for the check, and it was released',
    )
  } finally {
    ProxyAgent.prototype.close = originalClose
    await proxy.close()
  }
})

test('a disabled route with no endpoint is refused with the real reason', async () => {
  // Answering "not enabled" here would name a cause that is not the case: the
  // card has an endpoint block the user simply has not filled in yet.
  const { routes } = mountHost({
    providers: { get: () => ({ p: { enabled: false, protocol: 'http', host: '', port: 0 } }) },
    testUrl: 'http://echo.invalid/ip',
  })
  const { status, body } = await selfCheck(routes, { provider: 'p' })
  assert.equal(status, 200)
  assert.equal(body.ok, false)
  assert.equal(body.kind, 'route-rejected')
  assert.match(body.error, /未填写代理地址/, 'the report must name the missing setting')
})

test('a disabled route runs the same credential guards as routing', async () => {
  const { routes } = mountHost({
    providers: {
      get: () => ({
        p: { enabled: false, protocol: 'http', host: 'proxy.test', port: 8080, password: 'secret' },
      }),
    },
    testUrl: 'http://echo.invalid/ip',
  })
  const { body } = await selfCheck(routes, { provider: 'p' })
  assert.equal(body.kind, 'route-rejected')
  assert.match(body.error, /没有用户名/, 'a setting routing would refuse is not reported as fine')
})

test('a provider with no config at all is still reported as not enabled', async () => {
  const { routes } = mountHost({ providers: { get: () => ({}) }, testUrl: 'http://echo.invalid/ip' })
  const { body } = await selfCheck(routes, { provider: 'p' })
  assert.equal(body.ok, false)
  assert.equal(body.kind, 'no-route')
})

// ---- the provider's real upstream as the default check target ----

/** A directory entry plus the settings section an llm-pi-ai route would publish. */
const publishedUpstream = () => ({
  configurable: [
    { provider: 'p', displayName: 'P', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'p'] },
  ],
  settings: {
    get: ns =>
      ns === 'llm-pi-ai'
        ? { providers: { p: { baseURL: 'http://echo.invalid/upstream' } } }
        : undefined,
  },
})

test('the check defaults to the upstream the adapter publishes', async () => {
  // `listProviders()` carries only { id, name }; the address comes from the
  // adapter's settings section, reached through the configurable-provider
  // directory. Without this the check only proves the proxy answers.
  const proxy = await startEchoProxy()
  try {
    const { routes } = mountHost(oneRoute(proxy.port), publishedUpstream())
    const { body } = await selfCheck(routes, { provider: 'p' })
    assert.equal(body.ok, true)
    assert.equal(
      proxy.seen[0].url,
      'http://echo.invalid/upstream',
      'the check must use the real upstream, not the bare echo service',
    )
  } finally {
    await proxy.close()
  }
})

test('an adapter whose whole section is the profile is read too', async () => {
  const proxy = await startEchoProxy()
  try {
    const { routes } = mountHost(oneRoute(proxy.port), {
      configurable: [{ provider: 'p', displayName: 'P', settingsNs: 'llm-deepseek', settingsPath: [] }],
      settings: { get: () => ({ baseURL: 'http://echo.invalid/deepseek' }) },
    })
    await selfCheck(routes, { provider: 'p' })
    assert.equal(
      proxy.seen[0].url,
      'http://echo.invalid/deepseek',
      'an empty settingsPath means the section IS the profile',
    )
  } finally {
    await proxy.close()
  }
})

test('a route testTarget still wins over the published upstream', async () => {
  const proxy = await startEchoProxy()
  try {
    const { routes } = mountHost(
      {
        providers: {
          get: () => ({
            p: {
              enabled: true,
              protocol: 'http',
              host: '127.0.0.1',
              port: proxy.port,
              testTarget: 'http://echo.invalid/explicit',
            },
          }),
        },
        testUrl: 'http://echo.invalid/ip',
      },
      publishedUpstream(),
    )
    await selfCheck(routes, { provider: 'p' })
    assert.equal(proxy.seen[0].url, 'http://echo.invalid/explicit')
  } finally {
    await proxy.close()
  }
})

test('without the settings service the check falls back to testUrl', async () => {
  const proxy = await startEchoProxy()
  try {
    const { routes } = mountHost(oneRoute(proxy.port))
    await selfCheck(routes, { provider: 'p' })
    assert.equal(proxy.seen[0].url, 'http://echo.invalid/ip', 'no integration, no behaviour change')
  } finally {
    await proxy.close()
  }
})

test('a namespace that is not registered yet falls back to testUrl', async () => {
  const proxy = await startEchoProxy()
  try {
    const { routes } = mountHost(oneRoute(proxy.port), {
      configurable: [
        { provider: 'p', displayName: 'P', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'p'] },
      ],
      settings: { get: () => undefined }, // service present, namespace absent
    })
    await selfCheck(routes, { provider: 'p' })
    assert.equal(proxy.seen[0].url, 'http://echo.invalid/ip')
  } finally {
    await proxy.close()
  }
})

test('a 4xx from the upstream counts as reachable', async () => {
  // A bare POST to a real endpoint normally answers 401/404 — that IS the answer,
  // and reaching it proves the path works. Reporting it as a failure would make
  // the check useless against every real upstream.
  const proxy = await startEchoProxy(0, 401)
  try {
    const { routes } = mountHost(oneRoute(proxy.port))
    const { body } = await selfCheck(routes, { provider: 'p' })
    assert.equal(body.ok, true, 'reaching the upstream is success, whatever it answered')
    assert.equal(body.status, 401)
  } finally {
    await proxy.close()
  }
})

test('a 5xx reads as a broken path, not a success', async () => {
  // An HTTP proxy that cannot reach its upstream answers 502/503/504 ITSELF, so
  // this is the one status that must never be reported as "fine".
  const proxy = await startEchoProxy(0, 502)
  try {
    const { routes } = mountHost(oneRoute(proxy.port))
    const { body } = await selfCheck(routes, { provider: 'p' })
    assert.equal(body.ok, false)
    assert.equal(body.status, 502)
    assert.match(body.error, /502/, 'a bare "测试失败" points at nothing; the status must be named')
  } finally {
    await proxy.close()
  }
})

// ---- several echo hosts as fallback candidates ----

/** A proxy whose reply depends on the target, so a candidate walk is observable. */
async function startScriptedProxy(reply) {
  const seen = []
  const server = createServer((req, res) => {
    seen.push(req.url)
    const { status, body, headers } = reply(req.url)
    if (headers !== undefined) {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value)
    }
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(body)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { seen, port, close: () => new Promise(resolve => server.close(resolve)) }
}

const routeToProxy = port => ({
  providers: { get: () => ({ p: { enabled: true, protocol: 'http', host: '127.0.0.1', port } }) },
})

test('testUrl may name several echo hosts, tried in order', async () => {
  // Any single public echo host can be unreachable on some networks, and a check
  // that fails for THAT reason is a check nobody trusts. The first candidate here
  // is answered by the proxy itself with a 502 (it cannot reach that upstream).
  const proxy = await startScriptedProxy(url =>
    String(url).includes('first.invalid')
      ? { status: 502, body: '{"error":"upstream"}' }
      : { status: 200, body: JSON.stringify({ ip: '203.0.113.9' }) },
  )
  try {
    const { routes } = mountHost({
      ...routeToProxy(proxy.port),
      testUrl: 'http://first.invalid/ip, http://second.invalid/ip',
    })
    const { body } = await selfCheck(routes, { provider: 'p' })
    assert.equal(body.ok, true, 'the second candidate answered, so the setting is fine')
    assert.equal(body.exitIp, '203.0.113.9')
    assert.deepEqual(
      proxy.seen,
      ['http://first.invalid/ip', 'http://second.invalid/ip'],
      'both candidates were tried, in the order the setting lists them',
    )
  } finally {
    await proxy.close()
  }
})

test('a 407 stops the walk: another candidate would ask the same question', async () => {
  // A real proxy challenge carries `Proxy-Authenticate`; undici THROWS on it
  // rather than handing back the response, which is why the whole cause chain is
  // searched for the 407 when classifying.
  const proxy = await startScriptedProxy(() => ({
    status: 407,
    body: '{}',
    headers: { 'proxy-authenticate': 'Basic' },
  }))
  try {
    const { routes } = mountHost({
      ...routeToProxy(proxy.port),
      testUrl: 'http://first.invalid/ip, http://second.invalid/ip',
    })
    const { body } = await selfCheck(routes, { provider: 'p' })
    assert.equal(body.kind, 'proxy-auth', 'the proxy is the problem, and it is named')
    assert.equal(proxy.seen.length, 1, 'no point asking a second host the same question')
  } finally {
    await proxy.close()
  }
})

test('the candidate list is capped so one setting cannot multiply outbound calls', async () => {
  const proxy = await startScriptedProxy(() => ({ status: 502, body: '{}' }))
  try {
    const { routes } = mountHost({
      ...routeToProxy(proxy.port),
      testUrl: [
        'http://a.invalid/ip',
        'http://b.invalid/ip',
        'http://c.invalid/ip',
        'http://d.invalid/ip',
        'http://e.invalid/ip',
        'http://f.invalid/ip',
        'http://g.invalid/ip',
      ].join(' '),
    })
    const { body } = await selfCheck(routes, { provider: 'p' })
    assert.equal(body.ok, false)
    // MAX_TEST_TARGETS is 5; a longer list must not become a longer walk.
    assert.equal(proxy.seen.length, 5, `expected 5 attempts, got ${proxy.seen.length}`)
  } finally {
    await proxy.close()
  }
})

// ---- the check honours the SAME proxy/direct rule real traffic does ----

test('a loopback upstream is checked DIRECT, never forced through the proxy', async () => {
  // A local relay (LiteLLM, Ollama, a mock) is the common case now that the
  // check defaults to the provider's real upstream. Forcing it through a forward
  // proxy that cannot reach it would report a HEALTHY route as "the proxy is
  // broken" — the exact false positive `localDirect` exists to remove. The echo
  // server stands in for the relay; the scripted proxy answers every target with
  // a 502, so a proxied probe could not possibly succeed.
  const echo = await startEchoProxy()
  const proxy = await startScriptedProxy(() => ({ status: 502, body: '{}' }))
  try {
    const { routes } = mountHost({
      providers: {
        get: () => ({
          p: {
            enabled: true,
            protocol: 'http',
            host: '127.0.0.1',
            port: proxy.port,
            testTarget: `http://127.0.0.1:${echo.port}/upstream`,
          },
        }),
      },
      testUrl: 'http://echo.invalid/ip',
    })
    const { body } = await selfCheck(routes, { provider: 'p' })
    assert.equal(body.ok, true, 'reaching the loopback upstream is a success')
    assert.equal(body.viaProxy, false, 'the loopback target must be reached direct')
    assert.equal(echo.seen.length, 1, 'the request went straight to the local upstream')
    assert.equal(proxy.seen.length, 0, 'the proxy must not have been used at all')
  } finally {
    await echo.close()
    await proxy.close()
  }
})

test('a failed direct probe names the target, never a proxy it never used', async () => {
  // Nothing listens on this loopback port, and the target is loopback, so the
  // route decides DIRECT. Reporting "代理不可达" here would send the operator
  // after a hop this probe never touched.
  const proxy = await startScriptedProxy(() => ({ status: 502, body: '{}' }))
  try {
    const { routes } = mountHost({
      providers: {
        get: () => ({
          p: {
            enabled: true,
            protocol: 'http',
            host: '127.0.0.1',
            port: proxy.port,
            testTarget: 'http://127.0.0.1:65533/upstream',
          },
        }),
      },
      testUrl: 'http://echo.invalid/ip',
    })
    const { body } = await selfCheck(routes, { provider: 'p' })
    assert.equal(body.ok, false)
    assert.equal(body.viaProxy, false)
    assert.equal(body.kind, 'target', 'a direct failure is about the target, not the proxy')
    assert.match(body.error, /目标不可达/, 'the report must name the hop that actually failed')
    assert.ok(!body.error.includes('代理'), 'a direct probe must never blame a proxy it did not use')
    assert.equal(proxy.seen.length, 0, 'the proxy was never contacted')
  } finally {
    await proxy.close()
  }
})

// ---- the cooldown caches a configuration, not a provider id ----

test('a configuration change inside the cooldown is re-checked, not answered from the old result', async () => {
  // Test -> see a failure -> fix the target -> test again must NOT return the
  // pre-fix answer. The cooldown key includes the configuration, so an edit
  // outside it produces a fresh outbound request.
  const proxy = await startEchoProxy()
  try {
    const providers = {
      p: {
        enabled: false,
        protocol: 'http',
        host: '127.0.0.1',
        port: proxy.port,
        testTarget: 'http://echo.invalid/one',
      },
    }
    // A mutable config: `get()` returns the live object, so flipping a field is
    // exactly what a settings write does.
    const { routes } = mountHost({ providers: { get: () => providers }, testUrl: 'http://echo.invalid/ip' })

    const first = await selfCheck(routes, { provider: 'p' })
    assert.equal(first.body.cached, undefined, 'the first check is fresh')
    assert.equal(proxy.seen[0].url, 'http://echo.invalid/one')

    providers.p.testTarget = 'http://echo.invalid/two'
    const second = await selfCheck(routes, { provider: 'p' })
    assert.notEqual(second.body.cached, true, 'a changed configuration must not be answered from the cooldown')
    assert.equal(proxy.seen.length, 2, 'the new configuration got its own outbound request')
    assert.equal(proxy.seen[1].url, 'http://echo.invalid/two')
  } finally {
    await proxy.close()
  }
})

test('the cooldown key covers the routing rules, not just the proxy address', async () => {
  // `bypassHosts`/`onlyHosts`/`localDirect` decide whether the probe is proxied or
  // direct, which is exactly what `viaProxy` — and therefore the whole diagnosis —
  // reports. An edit to one of them inside the cooldown used to hand back the
  // pre-edit `viaProxy` with `cached: true` and issue no request at all.
  //
  // The route is DISABLED on purpose: a disabled one is rebuilt from the config on
  // every check (that is the pre-enable flow this feature exists for), so flipping
  // a field is the only variable here. An enabled route would sit in the built
  // table until a settings event rebuilt it, which is a different path.
  const proxy = await startScriptedProxy(() => ({ status: 200, body: JSON.stringify({ ip: '203.0.113.9' }) }))
  try {
    const providers = {
      p: {
        enabled: false,
        protocol: 'http',
        host: '127.0.0.1',
        port: proxy.port,
        testTarget: 'http://echo.invalid/ip',
        bypassHosts: '',
      },
    }
    const { routes } = mountHost({ providers: { get: () => providers } })

    const first = await selfCheck(routes, { provider: 'p' })
    assert.equal(first.body.viaProxy, true, 'nothing bypasses this target yet')
    assert.equal(proxy.seen.length, 1)

    // The same target, now explicitly direct. The answer CHANGES, so the cooldown
    // must not be allowed to answer for the old one.
    providers.p.bypassHosts = 'echo.invalid'
    const second = await selfCheck(routes, { provider: 'p' })
    assert.notEqual(second.body.cached, true, 'a changed routing rule must not be answered from the cooldown')
    assert.equal(second.body.viaProxy, false, 'the new rule decided this probe')
    assert.equal(proxy.seen.length, 1, 'a direct probe must not cross the proxy')
  } finally {
    await proxy.close()
  }
})

test('the cooldown key covers testUrl, which is what a route without a target uses', async () => {
  // The top-level `testUrl` is the target whenever the route names none — the
  // common case for a provider whose adapter publishes no upstream. Editing it
  // inside the cooldown used to return the old answer untouched.
  const proxy = await startScriptedProxy(() => ({ status: 200, body: JSON.stringify({ ip: '203.0.113.9' }) }))
  try {
    const config = {
      providers: { get: () => ({ p: { enabled: true, protocol: 'http', host: '127.0.0.1', port: proxy.port } }) },
      testUrl: 'http://first.invalid/ip',
    }
    const { routes } = mountHost(config)

    const first = await selfCheck(routes, { provider: 'p' })
    assert.equal(first.body.ok, true)
    assert.deepEqual(proxy.seen, ['http://first.invalid/ip'])

    config.testUrl = 'http://second.invalid/ip'
    const second = await selfCheck(routes, { provider: 'p' })
    assert.notEqual(second.body.cached, true, 'a changed testUrl must not be answered from the cooldown')
    assert.deepEqual(
      proxy.seen,
      ['http://first.invalid/ip', 'http://second.invalid/ip'],
      'the new target was actually tried',
    )
  } finally {
    await proxy.close()
  }
})

test('the cooldown still caches an UNCHANGED configuration', async () => {
  // The fingerprint must not be so eager that it defeats the cooldown it exists to
  // key: an impatient second click on an untouched route gets the remembered
  // answer, marked `cached`, with no new outbound request.
  const proxy = await startEchoProxy()
  try {
    const { routes } = mountHost(oneRoute(proxy.port))
    const first = await selfCheck(routes, { provider: 'p' })
    assert.equal(first.body.cached, undefined)
    const second = await selfCheck(routes, { provider: 'p' })
    assert.equal(second.body.cached, true, 'an unchanged configuration is still cached')
    assert.equal(second.body.exitIp, first.body.exitIp)
    assert.equal(proxy.seen.length, 1, 'the cached answer cost no outbound request')
  } finally {
    await proxy.close()
  }
})

