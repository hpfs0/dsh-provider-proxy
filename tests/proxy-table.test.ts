import test from 'node:test'
import assert from 'node:assert/strict'

import { closeTable, createProxyTable, proxyUrl } from '../lib/index.js'

test('proxyUrl assembles host, port and protocol', () => {
  assert.equal(
    proxyUrl({ enabled: true, protocol: 'http', host: '127.0.0.1', port: 7890, username: '', password: '' }),
    'http://127.0.0.1:7890',
  )
})

test('proxyUrl brackets an IPv6 literal', () => {
  assert.equal(
    proxyUrl({ enabled: true, protocol: 'http', host: '::1', port: 1080, username: '', password: '' }),
    'http://[::1]:1080',
  )
})

test('proxyUrl includes a username but never the password', () => {
  const url = proxyUrl({
    enabled: true,
    protocol: 'http',
    host: 'proxy.test',
    port: 8080,
    username: 'alice',
    password: 'hunter2',
  })
  assert.equal(url, 'http://alice@proxy.test:8080')
  assert.ok(!url.includes('hunter2'))
})

test('each enabled provider gets its own dispatcher', async () => {
  const { entries } = await createProxyTable({
    a: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 7890 },
    b: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 7890 },
  })
  assert.equal(entries.size, 2)
  // Same proxy address, but never the same dispatcher instance.
  assert.notEqual(entries.get('a').dispatcher, entries.get('b').dispatcher)
  await closeTable(entries)
})

test('disabled and absent providers create no dispatcher', async () => {
  const { entries } = await createProxyTable({
    off: { enabled: false, protocol: 'http', host: '127.0.0.1', port: 7890 },
  })
  assert.equal(entries.size, 0)
  await closeTable(entries)
})

test('one invalid route does not prevent the others from proxying', async () => {
  const { entries, problems } = await createProxyTable({
    good: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 7890 },
    bad: { enabled: true, protocol: 'http', host: '127.0.0.1', port: 0 },
  })
  assert.equal(entries.size, 1)
  assert.ok(entries.has('good'))
  assert.match(problems.get('bad'), /端口无效/)
  await closeTable(entries)
})

test('socks5 builds a dispatcher instead of being rejected', async () => {
  const { entries, problems } = await createProxyTable({
    s: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: 1080 },
  })
  assert.equal(problems.size, 0, 'socks5 is implemented via undici Socks5ProxyAgent')
  assert.equal(entries.size, 1)
  await closeTable(entries)
})

test('a socks5 origin is reported, not the "null" a non-special scheme yields', async () => {
  // `new URL('socks5://…').origin` is the STRING 'null' — WHATWG serializes a
  // non-special scheme's origin that way, so diagnostics would show nothing.
  assert.equal(new URL('socks5://127.0.0.1:1080').origin, 'null')

  const { entries } = await createProxyTable({
    s: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: 1080 },
  })
  assert.equal(entries.get('s').proxyOrigin, 'socks5://127.0.0.1:1080')
  await closeTable(entries)
})

test('a socks5 origin carries no credentials', async () => {
  const { entries } = createProxyTable({
    s: {
      enabled: true,
      protocol: 'socks5',
      host: 'proxy.test',
      port: 1080,
      username: 'alice',
      password: 'hunter2',
    },
  })
  assert.equal(entries.get('s').proxyOrigin, 'socks5://proxy.test:1080')
  assert.ok(!entries.get('s').proxyOrigin.includes('hunter2'))
  await closeTable(entries)
})

test('a socks5 username without a password is refused, never downgraded to NO_AUTH', async () => {
  const { entries, problems } = await createProxyTable({
    s: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: 1080, username: 'alice' },
  })
  assert.equal(entries.size, 0)
  assert.match(problems.get('s'), /用户名/)
  assert.match(problems.get('s'), /密码/)
})

test('a socks5 username WITH a password builds a dispatcher', async () => {
  const { entries, problems } = createProxyTable({
    s: {
      enabled: true,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'alice',
      password: 'hunter2',
    },
  })
  assert.equal(problems.size, 0)
  assert.equal(entries.size, 1)
  await closeTable(entries)
})

test('socks5 without any credentials is a normal unauthenticated tunnel', async () => {
  const { entries, problems } = await createProxyTable({
    s: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: 1080 },
  })
  assert.equal(problems.size, 0, 'no username means no password is required')
  assert.equal(entries.size, 1)
  await closeTable(entries)
})

test('the reported origin carries no credentials', async () => {
  const { entries } = await createProxyTable({
    p: { enabled: true, protocol: 'http', host: 'proxy.test', port: 8080, username: 'alice' },
  })
  assert.equal(entries.get('p').proxyOrigin, 'http://proxy.test:8080')
  await closeTable(entries)
})
