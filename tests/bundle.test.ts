import test from 'node:test'
import assert from 'node:assert/strict'

// Test against the BUILT bundle, which is what the Host actually loads. This
// also keeps the `.js` specifiers in src/ (required by the compiler) working
// under plain Node without a loader hook.
const { Config, normalizeRoute, PROTOCOLS } = await import('../lib/index.js')

const base = { enabled: true, protocol: 'http', host: '127.0.0.1', port: 7890 }

test('the bundle exports the plugin contract', () => {
  assert.equal(typeof normalizeRoute, 'function')
  // A schemastery schema is callable, not a plain object.
  assert.equal(typeof Config, 'function')
  assert.deepEqual([...PROTOCOLS], ['http', 'https', 'socks5'])
})

test('the bundle is NOT stale relative to src/', async () => {
  // These tests import lib/, so editing src/ without rebuilding silently tests
  // the OLD code. That already happened once: a socks5 source change went
  // unbuilt, and the suite still "passed" 78/78 while the e2e tests ran against
  // a table that still rejected socks5 outright. The symptom was a misleading
  // `fetch failed` rather than an obvious failure.
  const { readFileSync } = await import('node:fs')
  const built = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const source = readFileSync(new URL('../src/proxy-table.ts', import.meta.url), 'utf8')

  // A marker that moves whenever the SOCKS5 wiring is added or removed.
  const inSource = source.includes('Socks5ProxyAgent')
  const inBundle = built.includes('Socks5ProxyAgent')
  assert.equal(
    inBundle,
    inSource,
    'lib/index.js is out of date with src/proxy-table.ts — run `npm run build`',
  )
})

test('accepts a complete enabled route', () => {
  const route = normalizeRoute('openrouter', base)
  assert.equal(route.enabled, true)
  assert.equal(route.host, '127.0.0.1')
  assert.equal(route.port, 7890)
})

test('trims surrounding whitespace on host and username', () => {
  const route = normalizeRoute('p', { ...base, host: '  10.0.0.1 ', username: ' bob ' })
  assert.equal(route.host, '10.0.0.1')
  assert.equal(route.username, 'bob')
})

test('rejects an enabled route with no host', () => {
  assert.throws(() => normalizeRoute('p', { ...base, host: '   ' }), /未填写代理地址/)
})

test('rejects a host carrying a scheme or path', () => {
  assert.throws(() => normalizeRoute('p', { ...base, host: 'http://10.0.0.1' }), /只能填 IPv4、IPv6 或域名/)
  assert.throws(() => normalizeRoute('p', { ...base, host: '10.0.0.1/proxy' }), /只能填 IPv4、IPv6 或域名/)
})

test('rejects a malformed proxy host', () => {
  assert.throws(() => normalizeRoute('p', { ...base, host: 'bad host' }), /只能填 IPv4、IPv6 或域名/)
  assert.throws(() => normalizeRoute('p', { ...base, host: 'alice@proxy.test' }), /只能填 IPv4、IPv6 或域名/)
  assert.throws(() => normalizeRoute('p', { ...base, host: '127.0.0.1:7890' }), /只能填 IPv4、IPv6 或域名/)
})

test('rejects an out-of-range or fractional port', () => {
  assert.throws(() => normalizeRoute('p', { ...base, port: 0 }), /代理端口无效/)
  assert.throws(() => normalizeRoute('p', { ...base, port: 70000 }), /代理端口无效/)
  assert.throws(() => normalizeRoute('p', { ...base, port: 1.5 }), /代理端口无效/)
})

test('a disabled route needs no host or port', () => {
  const route = normalizeRoute('p', { enabled: false, protocol: 'http', host: '', port: 0 })
  assert.equal(route.enabled, false)
})

test('the provider id appears in the error message', () => {
  assert.throws(() => normalizeRoute('sensenova', { ...base, port: 0 }), /sensenova/)
})

test('applying the schema produces defaults for omitted fields', () => {
  const parsed = Config({ providers: { p: { enabled: true, host: 'h', port: 1 } } })
  const providers = parsed.providers
  const snapshot = typeof providers.get === 'function' ? providers.get() : providers
  assert.equal(snapshot.p.enabled, true)
  assert.equal(snapshot.p.protocol, 'http', 'protocol defaults')
  assert.equal(snapshot.p.username, '')
  assert.equal(snapshot.p.password, '')
})