// N24 — search / reasoning traffic split.
//
// `web_search` reaches the network with a bare global `fetch` inside
// `ctx.web.search`. The Host wraps that METHOD and, per call, decides which
// chain carries it:
//
//   inherit   → the reserved `web-search` card (pre-1.1.0 behaviour)
//   dedicated → a dispatcher built from ONE proxy preset
//   direct    → the native path, never a proxy
//   custom    → the card, including its target-host rules
//
// The decision itself lives in `src/search-split.ts` and is pinned here without
// any I/O; the rest of the file proves the Host honours it, that reasoning
// traffic is untouched, and that a broken binding FAILS CLOSED (never direct).

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

const {
  apply,
  SEARCH_PROXY_STRATEGIES,
  DEFAULT_SEARCH_PROXY_STRATEGY,
  normalizeSearchSplitConfig,
  resolveSearchPlan,
  searchSplitProblem,
} = await import('../lib/index.js')

// ---- the resolver, on its own ------------------------------------------------

test('N24: the split strategy defaults to inherit and an unknown value degrades to it', () => {
  assert.deepEqual(
    [...SEARCH_PROXY_STRATEGIES],
    ['inherit', 'dedicated', 'direct', 'custom'],
    'the menu order is the documented one',
  )
  assert.equal(DEFAULT_SEARCH_PROXY_STRATEGY, 'inherit', '1.0.0 behaviour is the default')
  assert.deepEqual(normalizeSearchSplitConfig(undefined), {
    searchProxyStrategy: 'inherit',
    searchProxyProfileId: '',
  })
  assert.deepEqual(
    normalizeSearchSplitConfig({ searchProxyStrategy: 'nonsense' }),
    { searchProxyStrategy: 'inherit', searchProxyProfileId: '' },
    'a value written by a newer version must not break this one',
  )
  assert.deepEqual(
    normalizeSearchSplitConfig({ searchProxyStrategy: 'dedicated', searchProxyProfileId: '  pool  ' }),
    { searchProxyStrategy: 'dedicated', searchProxyProfileId: 'pool' },
    'the binding is trimmed',
  )
  // Toggling dedicated → inherit → dedicated must not lose the binding.
  assert.equal(
    normalizeSearchSplitConfig({ searchProxyStrategy: 'inherit', searchProxyProfileId: 'pool' })
      .searchProxyProfileId,
    'pool',
  )
})

test('N24: the plan matrix names the chain each strategy takes', () => {
  const base = { cardAvailable: true, presetExists: true, presetReady: true }

  assert.deepEqual(resolveSearchPlan({ ...base, strategy: 'inherit' }), {
    kind: 'card',
    reason: 'inherit',
  })
  assert.deepEqual(
    resolveSearchPlan({ ...base, strategy: 'inherit', cardAvailable: false }),
    { kind: 'direct', reason: 'no-route' },
    'no enabled card means direct, exactly as before 1.1.0',
  )
  assert.deepEqual(
    resolveSearchPlan({ ...base, strategy: 'direct', cardAvailable: false }),
    { kind: 'direct', reason: 'strategy' },
    'an explicit "direct" is an answer, not a missing route',
  )
  assert.deepEqual(resolveSearchPlan({ ...base, strategy: 'custom' }), {
    kind: 'card',
    reason: 'custom',
  })
  assert.deepEqual(
    resolveSearchPlan({ ...base, strategy: 'dedicated', profileId: 'pool' }),
    { kind: 'dedicated', reason: 'dedicated', profileId: 'pool' },
  )
  // No binding: the card's OWN endpoint is the independent endpoint.
  assert.deepEqual(
    resolveSearchPlan({ ...base, strategy: 'dedicated' }),
    { kind: 'card', reason: 'dedicated-card' },
  )
  assert.deepEqual(
    resolveSearchPlan({ ...base, strategy: 'dedicated', cardAvailable: false }),
    { kind: 'direct', reason: 'no-route' },
  )
  // The emergency switch beats every strategy, including a blocked one.
  assert.deepEqual(
    resolveSearchPlan({ ...base, strategy: 'dedicated', profileId: 'gone', presetExists: false, bypassAll: true }),
    { kind: 'direct', reason: 'bypass-all' },
  )
})

test('N24: a dedicated binding that cannot be honoured is blocked, never silently direct', () => {
  const blocked = {
    strategy: 'dedicated',
    profileId: 'gone',
    cardAvailable: true,
    presetExists: false,
    presetReady: false,
  }
  assert.deepEqual(resolveSearchPlan(blocked), { kind: 'blocked', reason: 'missing-preset' })
  assert.deepEqual(resolveSearchPlan({ ...blocked, presetExists: true }), {
    kind: 'blocked',
    reason: 'invalid-preset',
  })

  const missing = searchSplitProblem(blocked) ?? ''
  assert.match(missing, /「gone」不存在/, 'the message names the preset the user bound')
  assert.match(missing, /不会改走直连/, 'and says the call is not leaked direct')
  assert.match(searchSplitProblem({ ...blocked, presetExists: true }) ?? '', /配置不完整/)

  assert.equal(
    searchSplitProblem({ strategy: 'inherit', presetExists: false, presetReady: false }),
    undefined,
    'only a dedicated binding produces a problem',
  )
  assert.equal(searchSplitProblem({ strategy: 'direct', presetExists: false, presetReady: false }), undefined)
})

// ---- the Host, against real proxies -----------------------------------------

/** A fake HTTP forward proxy: answers 200 and records the absolute-form target. */
async function startRecordingProxy() {
  const seen: { url: string }[] = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url ?? '' })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"sources":[]}')
  })
  server.on('connect', (req, socket) => {
    seen.push({ url: req.url ?? '' })
    socket.on('error', () => {})
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    socket.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as any).port as number
  return {
    seen,
    port,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 60))

/**
 * A stand-in `ctx.web` whose `search` reaches the network with a bare global
 * fetch — exactly what a real search provider does, and the only thing the
 * router wrapper can see. It is a PROTOTYPE method so the dispose guard deletes
 * an own property and lets the original show through.
 */
class FakeWeb {
  async search() {
    await fetch('http://search.invalid/api/search')
    return { sources: [], truncated: false }
  }
}

function asServiceProxy(instance: any) {
  return new Proxy(instance, {
    get: (target, prop, receiver) => {
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? (...args: any[]) => value.apply(receiver, args) : value
    },
  })
}

const route = (port: number) => ({ enabled: true, protocol: 'http', host: '127.0.0.1', port })

/**
 * Mount the Host half with a fake web service, a fake web server and a fake
 * `llm` service, so ONE process can exercise both traffic types.
 */
function mount(options: {
  providers: Record<string, unknown>
  profiles?: Record<string, unknown>
  strategy?: string
  profileId?: string
}) {
  const disposers: Array<() => unknown> = []
  const listeners: Array<{ event: string; fn: Function }> = []
  const routes = new Map<string, Function>()
  const web = asServiceProxy(new FakeWeb())
  const ctx: any = {
    on(event: string, fn: Function) {
      listeners.push({ event, fn })
      return () => {}
    },
    effect(fn: Function) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose as () => unknown)
      return () => {}
    },
    logger: { info() {}, error() {}, warn() {} },
    inject(services: string[], cb: Function) {
      if (services.includes('web')) cb({ web, effect: ctx.effect })
      if (services.includes('webServer')) {
        cb({ webServer: { register: (r: any) => routes.set(r.path, r.handler) } })
      }
      return () => {}
    },
    llm: { listProviders: () => [], listConfigurableProviders: () => [] },
  }
  const config: Record<string, unknown> = {
    providers: { get: () => options.providers },
    ...(options.profiles === undefined ? {} : { proxyProfiles: { get: () => options.profiles } }),
    ...(options.strategy === undefined ? {} : { searchProxyStrategy: { get: () => options.strategy } }),
    ...(options.profileId === undefined ? {} : { searchProxyProfileId: { get: () => options.profileId } }),
  }
  apply(ctx, config)
  return {
    ctx,
    web,
    listeners,
    routes,
    state: () => ctx.providerProxyState,
    async dispose() {
      for (const dispose of disposers) await dispose()
    },
  }
}

/**
 * Drive the `llm/stream` waterfall the way an adapter does: the request is
 * issued inside the stream, i.e. lazily, on the first `next()`.
 */
async function runReasoning(harness: ReturnType<typeof mount>, provider = 'deepseek') {
  const listener = harness.listeners.find(entry => entry.event === 'llm/stream')
  assert.ok(listener, 'the plugin registered the llm/stream waterfall')
  const stream = listener!.fn({ provider }, async function* () {
    await fetch('http://upstream.invalid/v1/chat/completions')
    yield { text: 'ok' }
  })
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Read the JSON payload the page's catalogue endpoint answers with. */
function cataloguePayload(harness: ReturnType<typeof mount>) {
  const handler = harness.routes.get('/dsh-provider-proxy/providers')
  assert.ok(handler, 'the catalogue endpoint is registered')
  let body = ''
  const res = {
    writeHead() {},
    end(text: string) {
      body = text
    },
  }
  ;(handler as any)({}, res)
  return JSON.parse(body)
}

test('N24: a dedicated binding carries search while reasoning keeps its own route', async () => {
  const reasoning = await startRecordingProxy()
  const search = await startRecordingProxy()
  const harness = mount({
    providers: { deepseek: route(reasoning.port), 'web-search': route(reasoning.port) },
    profiles: { 'search-pool': route(search.port) },
    strategy: 'dedicated',
    profileId: 'search-pool',
  })
  try {
    await settle()
    await harness.web.search({ query: 'x' })
    assert.equal(search.seen.length, 1, 'the search crossed the dedicated preset')
    assert.equal(reasoning.seen.length, 0, 'the search did NOT cross the card route')
    assert.equal(search.seen[0].url, 'http://search.invalid/api/search')

    await runReasoning(harness)
    assert.equal(reasoning.seen.length, 1, 'reasoning still crosses its own route')
    assert.equal(search.seen.length, 1, 'reasoning did not use the search proxy')

    const state = harness.state().search
    assert.equal(state.strategy, 'dedicated')
    assert.equal(state.plan, 'dedicated')
    assert.equal(state.proxied, 1)
    assert.equal(state.hits, 1, 'every search call is counted once')
    assert.equal(state.failed, 0)
    assert.equal(state.direct, 0)
    assert.match(String(state.endpoint), /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.equal(
      harness.state().hits['web-search'],
      1,
      'the reserved card still counts the call, so the totals stay truthful',
    )
  } finally {
    await harness.dispose()
    await reasoning.close()
    await search.close()
  }
})

test('N24: the direct strategy keeps search off every proxy and records the failure', async () => {
  const proxy = await startRecordingProxy()
  const harness = mount({
    providers: { deepseek: route(proxy.port), 'web-search': route(proxy.port) },
    strategy: 'direct',
  })
  try {
    await settle()
    // `search.invalid` does not resolve: the request fails at DNS, which is the
    // proof that it went to the native path rather than to the card's proxy.
    await assert.rejects(() => harness.web.search({ query: 'x' }))
    assert.equal(proxy.seen.length, 0, 'nothing crossed the proxy')

    const state = harness.state().search
    assert.equal(state.plan, 'direct')
    assert.equal(state.reason, 'strategy')
    assert.equal(state.direct, 1)
    assert.equal(state.hits, 1)
    assert.equal(state.failed, 1, 'a failed search is recorded, not hidden')
    assert.equal(state.ok, false)
    assert.ok(typeof state.code === 'string' && state.code.length > 0, 'the failure keeps its machine code')
    assert.equal(harness.state().hits['web-search'], undefined, 'no proxy carried it, so no hit')

    // Reasoning is untouched by the search strategy.
    await runReasoning(harness)
    assert.equal(proxy.seen.length, 1, 'reasoning still crosses its proxy')
  } finally {
    await harness.dispose()
    await proxy.close()
  }
})

test('N24: dedicated without a binding uses the card\'s own endpoint', async () => {
  const proxy = await startRecordingProxy()
  const harness = mount({
    providers: { 'web-search': route(proxy.port) },
    strategy: 'dedicated',
  })
  try {
    await settle()
    await harness.web.search({ query: 'x' })
    assert.equal(proxy.seen.length, 1, 'the card endpoint carried the search')

    const state = harness.state().search
    assert.equal(state.plan, 'card')
    assert.equal(state.reason, 'dedicated-card')
    assert.equal(state.proxied, 1)
  } finally {
    await harness.dispose()
    await proxy.close()
  }
})

test('N24: a missing preset REFUSES the search instead of leaking it direct', async () => {
  const proxy = await startRecordingProxy()
  const harness = mount({
    providers: { 'web-search': route(proxy.port) },
    profiles: {},
    strategy: 'dedicated',
    profileId: 'gone',
  })
  try {
    await settle()
    await assert.rejects(
      () => harness.web.search({ query: 'x' }),
      (error: any) => {
        assert.match(String(error?.message), /dsh-provider-proxy:/)
        assert.match(String(error?.message), /「gone」不存在/)
        assert.match(String(error?.message), /不会改走直连/)
        return true
      },
      'the call is refused with the reason, not failed for lack of a route',
    )
    assert.equal(proxy.seen.length, 0, 'nothing leaked onto any proxy')

    const state = harness.state().search
    assert.equal(state.plan, 'blocked')
    assert.equal(state.reason, 'missing-preset')
    assert.equal(state.failed, 1)
    assert.match(String(state.problem), /「gone」不存在/)
  } finally {
    await harness.dispose()
    await proxy.close()
  }
})

test('N24: custom hands the card complete control, including its host rules', async () => {
  // `onlyHosts` naming a different host means the card's rule sends
  // `search.invalid` direct. Under `custom` that verdict must be honoured —
  // that is the whole point of handing the card "everything".
  const proxy = await startRecordingProxy()
  const harness = mount({
    providers: {
      'web-search': { ...route(proxy.port), onlyHosts: 'other.invalid' },
    },
    strategy: 'custom',
  })
  try {
    await settle()
    await assert.rejects(() => harness.web.search({ query: 'x' }))
    assert.equal(proxy.seen.length, 0, 'the card rule kept the request off the proxy')

    const state = harness.state().search
    assert.equal(state.plan, 'card')
    assert.equal(state.reason, 'custom')
    assert.equal(state.direct, 1, 'the direct verdict is classified as search-direct')
  } finally {
    await harness.dispose()
    await proxy.close()
  }
})

test('N24: a failing search does not disturb reasoning traffic', async () => {
  const reasoning = await startRecordingProxy()
  // Reserve a port and release it: connecting there is refused, which is a
  // search-path failure the reasoning path must survive.
  const dead = await startRecordingProxy()
  const deadPort = dead.port
  await dead.close()

  const harness = mount({
    providers: { deepseek: route(reasoning.port) },
    profiles: { 'search-pool': route(deadPort) },
    strategy: 'dedicated',
    profileId: 'search-pool',
  })
  try {
    await settle()
    await assert.rejects(() => harness.web.search({ query: 'x' }))
    const state = harness.state().search
    assert.equal(state.failed, 1)
    assert.equal(state.ok, false)
    assert.equal(
      state.proxied,
      1,
      'a hit is counted at INITIATION, exactly like the card hit counter: the request did leave',
    )
    assert.equal(harness.state().hits['web-search'], 1, 'and the card counter agrees')

    const chunks = await runReasoning(harness)
    assert.deepEqual(chunks, [{ text: 'ok' }], 'reasoning completed')
    assert.equal(reasoning.seen.length, 1, 'reasoning still crossed its own proxy')
    assert.equal(harness.state().hits.deepseek, 1)
  } finally {
    await harness.dispose()
    await reasoning.close()
  }
})

test('N24: /providers publishes the split plan and its counters, and reset clears them', async () => {
  const proxy = await startRecordingProxy()
  const harness = mount({
    providers: { deepseek: route(proxy.port), 'web-search': route(proxy.port) },
    profiles: { 'search-pool': route(proxy.port) },
    strategy: 'dedicated',
    profileId: 'search-pool',
  })
  try {
    await settle()
    await harness.web.search({ query: 'x' })
    const payload = cataloguePayload(harness)
    assert.equal(payload.search.strategy, 'dedicated')
    assert.equal(payload.search.plan, 'dedicated')
    assert.equal(payload.search.profileId, 'search-pool')
    assert.equal(payload.search.proxied, 1)
    assert.equal(payload.search.hits, 1)
    assert.equal(payload.hits['web-search'], 1)
    assert.ok(payload.search.lastAt > 0, 'the page can say when the last search ran')
    assert.equal(payload.search.ok, true)

    const reset = harness.routes.get('/dsh-provider-proxy/reset-hits')
    assert.ok(reset, 'the reset endpoint is registered')
    const res = { writeHead() {}, end() {} }
    ;(reset as any)({}, res)

    const after = cataloguePayload(harness)
    assert.equal(after.search.hits, 0, 'reset clears the search counters too')
    assert.equal(after.search.proxied, 0)
    assert.equal(after.search.failed, 0)
    assert.equal(after.hits['web-search'], undefined)
    assert.equal(after.search.strategy, 'dedicated', 'reset clears history, not configuration')
    assert.equal(after.search.plan, 'dedicated')
  } finally {
    await harness.dispose()
    await proxy.close()
  }
})

test('N24: inherit keeps the pre-1.1.0 behaviour — card when enabled, direct otherwise', async () => {
  const proxy = await startRecordingProxy()
  const withCard = mount({
    providers: { 'web-search': route(proxy.port) },
    strategy: 'inherit',
  })
  const withoutCard = mount({
    providers: {},
    strategy: 'inherit',
  })
  try {
    await settle()
    await withCard.web.search({ query: 'x' })
    assert.equal(proxy.seen.length, 1, 'inherit sends search through the card')
    assert.equal(withCard.state().search.plan, 'card')
    assert.equal(withCard.state().search.reason, 'inherit')

    await assert.rejects(() => withoutCard.web.search({ query: 'x' }))
    assert.equal(withoutCard.state().search.plan, 'direct')
    assert.equal(withoutCard.state().search.reason, 'no-route')
  } finally {
    await withCard.dispose()
    await withoutCard.dispose()
    await proxy.close()
  }
})
