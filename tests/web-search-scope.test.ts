// `web_search` reaches the network with a BARE global `fetch` inside
// `ctx.web.search`, and `ctx.web` exposes no waterfall to hook. The plugin
// therefore wraps the service method itself. These tests pin that the wrapper
// routes the search through the reserved `web-search` route, stays out of the way
// when that route is absent, and is restored on dispose.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const { apply } = await import('../lib/index.js')

/** A fake HTTP forward proxy: answers 200 to the absolute-form request it sees. */
async function startRecordingProxy() {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"sources":[]}')
  })
  server.on('connect', (req, socket) => {
    seen.push({ url: req.url })
    socket.on('error', () => {})
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { seen, port, close: () => new Promise(resolve => server.close(resolve)) }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 60))

/**
 * A stand-in `ctx.web` whose `search` reaches the network like the real one.
 *
 * `search` is deliberately a PROTOTYPE method, exactly as it is on the real
 * `WebRuntime`. The plugin restores the service by deleting the own property it
 * installed, and only a prototype method proves that the original shows through
 * again: with an own property (an object literal) the same restore would look
 * like the method vanishing instead of the original coming back.
 */
class FakeWeb {
  async search() {
    // The provider-private client issues a plain global fetch — exactly what
    // dsh-web-search-deepseek does.
    await fetch('http://search.invalid/api/search')
    return { sources: [], truncated: false }
  }
}

/**
 * The ONE behaviour of Cordis's traceable service proxy that broke the restore:
 * `ctx.web` is a proxy, and reading a function-valued property through it returns
 * a fresh wrapper every time. `web.search === patched` can therefore never hold,
 * so a dispose guard written that way silently never fires. Own-property reads,
 * writes and deletes pass through to the instance, as they do under Cordis.
 */
function asServiceProxy(instance) {
  return new Proxy(instance, {
    get: (target, prop, receiver) => {
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? (...args) => value.apply(receiver, args) : value
    },
  })
}

/** Mount the Host half with the fake web service, collecting effect disposers. */
function mount(config) {
  const disposers = []
  // The plugin must see the service through the proxy, exactly as it does when
  // the real `ctx.web` is injected.
  const web = asServiceProxy(new FakeWeb())
  const ctx = {
    on: () => () => {},
    effect: fn => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    logger: { info() {}, error() {}, warn() {} },
    inject: (services, cb) => {
      if (services.includes('web')) cb({ web, effect: ctx.effect })
      return () => {}
    },
    llm: { listProviders: () => [], listConfigurableProviders: () => [] },
  }
  apply(ctx, config)
  const installed = () => Object.getOwnPropertyDescriptor(web, 'search')?.value
  return { web, disposers, installed }
}

const webSearchRoute = port => ({
  providers: {
    get: () => ({
      'web-search': { enabled: true, protocol: 'http', host: '127.0.0.1', port },
    }),
  },
})

test('web_search follows the reserved web-search route', async () => {
  const proxy = await startRecordingProxy()
  try {
    const { web } = mount(webSearchRoute(proxy.port))
    await settle()
    await web.search({ query: 'x' })
    assert.equal(proxy.seen.length, 1, 'the search request crossed the proxy')
    assert.equal(proxy.seen[0].url, 'http://search.invalid/api/search', 'the proxy saw the real target')
  } finally {
    await proxy.close()
  }
})

test('web_search stays direct when the web-search route is absent', async () => {
  const proxy = await startRecordingProxy()
  try {
    const { web } = mount({ providers: { get: () => ({}) } })
    await settle()
    // No proxy to reach: the direct request fails at DNS, which is the point.
    await assert.rejects(() => web.search({ query: 'x' }))
    assert.equal(proxy.seen.length, 0, 'nothing crossed the proxy')
  } finally {
    await proxy.close()
  }
})

test('disposing restores the original web.search', async () => {
  const proxy = await startRecordingProxy()
  try {
    const { web, disposers, installed } = mount(webSearchRoute(proxy.port))
    await settle()
    const original = Object.getPrototypeOf(web).search
    assert.notEqual(installed(), undefined, 'the wrapper must be installed while mounted')
    assert.notEqual(installed(), original, 'what is installed is our wrapper, not the prototype method')
    const before = proxy.seen.length
    await web.search({ query: 'x' })
    assert.equal(proxy.seen.length, before + 1, 'while mounted the search crosses the proxy')

    for (const dispose of disposers) await dispose()
    assert.equal(installed(), undefined, 'our own property is removed on dispose')
    assert.equal(Object.getPrototypeOf(web).search, original, 'the prototype method is untouched')

    const afterDispose = proxy.seen.length
    await assert.rejects(() => web.search({ query: 'x' }))
    assert.equal(proxy.seen.length, afterDispose, 'the restored search is no longer proxied')
  } finally {
    await proxy.close()
  }
})
