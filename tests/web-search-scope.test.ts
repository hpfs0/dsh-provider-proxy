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

/** A stand-in `ctx.web` whose `search` reaches the network like the real one. */
function makeWeb() {
  return {
    search: async () => {
      // The provider-private client issues a plain global fetch — exactly what
      // dsh-web-search-deepseek does.
      await fetch('http://search.invalid/api/search')
      return { sources: [], truncated: false }
    },
  }
}

/** Mount the Host half with the fake web service, collecting effect disposers. */
function mount(config) {
  const disposers = []
  const web = makeWeb()
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
  return { web, disposers }
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
    const { web, disposers } = mount(webSearchRoute(proxy.port))
    await settle()
    const patched = web.search
    for (const dispose of disposers) await dispose()
    assert.notEqual(web.search, patched, 'the wrapper must be removed on dispose')

    const before = proxy.seen.length
    await assert.rejects(() => web.search({ query: 'x' }))
    assert.equal(proxy.seen.length, before, 'the restored search is no longer proxied')
  } finally {
    await proxy.close()
  }
})
