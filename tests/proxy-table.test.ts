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

test('proxyUrl includes an http username and password', () => {
  const url = proxyUrl({
    enabled: true,
    protocol: 'http',
    host: 'proxy.test',
    port: 8080,
    username: 'alice',
    password: 'hunter2',
  })
  assert.equal(url, 'http://alice:hunter2@proxy.test:8080')
})

test('proxyUrl includes an https username and password', () => {
  const url = proxyUrl({
    enabled: true,
    protocol: 'https',
    host: 'proxy.test',
    port: 8443,
    username: 'alice',
    password: 'hunter2',
  })
  assert.equal(url, 'https://alice:hunter2@proxy.test:8443')
})

test('proxyUrl never puts a socks5 password in the URL', () => {
  // The SOCKS5 password is handed to Socks5ProxyAgent as an option, so it must
  // never enter the string the diagnostics derive an origin from.
  const url = proxyUrl({
    enabled: true,
    protocol: 'socks5',
    host: 'proxy.test',
    port: 1080,
    username: 'alice',
    password: 'hunter2',
  })
  assert.equal(url, 'socks5://alice@proxy.test:1080')
  assert.ok(!url.includes('hunter2'))
})

test('proxyUrl keeps a colon in the username percent-encoded', () => {
  // Rewriting %3A back to a literal ':' (as an earlier version did) makes the
  // WHATWG parser split userinfo there, turning `a:b` into user `a` + password
  // `b`. Keeping it encoded is what lets undici's decodeURIComponent restore the
  // real name.
  const url = proxyUrl({
    enabled: true,
    protocol: 'http',
    host: 'proxy.test',
    port: 8080,
    username: 'a:b',
    password: 'pw',
  })
  assert.equal(url, 'http://a%3Ab:pw@proxy.test:8080')
  assert.equal(new URL(url).username, 'a%3Ab', 'the encoded colon survives URL parsing')
  assert.equal(new URL(url).password, 'pw', 'the literal colon is the separator, not the name')
})

test('proxyUrl percent-encodes a password with special characters', () => {
  const url = proxyUrl({
    enabled: true,
    protocol: 'http',
    host: 'proxy.test',
    port: 8080,
    username: 'alice',
    password: 'p@ss:w/rd',
  })
  assert.equal(url, 'http://alice:p%40ss%3Aw%2Frd@proxy.test:8080')
  // Only one literal '@' remains, so the authority still parses unambiguously.
  assert.equal(new URL(url).hostname, 'proxy.test')
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

test('an http password without a username is refused', async () => {
  // Basic auth cannot send a password alone; dropping it silently would leave the
  // user believing a credential is in use when it is not.
  const { entries, problems } = await createProxyTable({
    p: { enabled: true, protocol: 'http', host: 'proxy.test', port: 8080, password: 'hunter2' },
  })
  assert.equal(entries.size, 0)
  assert.match(problems.get('p'), /密码/)
  assert.match(problems.get('p'), /用户名/)
})

test('an http username with a password builds a dispatcher', async () => {
  const { entries, problems } = await createProxyTable({
    p: {
      enabled: true,
      protocol: 'http',
      host: 'proxy.test',
      port: 8080,
      username: 'alice',
      password: 'hunter2',
    },
  })
  assert.equal(problems.size, 0)
  assert.equal(entries.size, 1)
  await closeTable(entries)
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
    p: {
      enabled: true,
      protocol: 'http',
      host: 'proxy.test',
      port: 8080,
      username: 'alice',
      password: 'hunter2',
    },
  })
  assert.equal(entries.get('p').proxyOrigin, 'http://proxy.test:8080')
  assert.ok(!entries.get('p').proxyOrigin.includes('hunter2'))
  await closeTable(entries)
})
