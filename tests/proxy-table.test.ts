import test from 'node:test'
import assert from 'node:assert/strict'

import { closeTable, createProxyTable, proxyUrl } from '../lib/index.js'

test('proxyUrl assembles host, port and protocol', () => {
  assert.equal(
    proxyUrl({ enabled: true, protocol: 'http', host: '127.0.0.1', port: 7890, username: '', passwordRef: '' }),
    'http://127.0.0.1:7890',
  )
})

test('proxyUrl brackets an IPv6 literal', () => {
  assert.equal(
    proxyUrl({ enabled: true, protocol: 'http', host: '::1', port: 1080, username: '', passwordRef: '' }),
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
    passwordRef: 'creds/provider-proxy',
  })
  assert.equal(url, 'http://alice@proxy.test:8080')
  assert.ok(!url.includes('creds/provider-proxy'))
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

test('socks5 is reported rather than silently mis-routed', async () => {
  const { entries, problems } = await createProxyTable({
    s: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: 1080 },
  })
  assert.equal(entries.size, 0, 'undici ProxyAgent cannot speak SOCKS5; do not route it as HTTP')
  assert.match(problems.get('s'), /socks5/)
})

test('the reported origin carries no credentials', async () => {
  const { entries } = await createProxyTable({
    p: { enabled: true, protocol: 'http', host: 'proxy.test', port: 8080, username: 'alice' },
  })
  assert.equal(entries.get('p').proxyOrigin, 'http://proxy.test:8080')
  await closeTable(entries)
})