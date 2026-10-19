import test from 'node:test'
import assert from 'node:assert/strict'

import { buildRouteEntry, closeTable, createProxyTable, defaultProxyProblem, normalizeDefaultProxy, normalizeRoute, proxyUrl } from '../lib/index.js'

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

test('a socks5 password without a username is refused, never silently dropped', async () => {
  // The mirror of the rule above, and for the same reason: undici only offers
  // USERNAME_PASSWORD when BOTH parts are present
  // (`if (options.username && options.password)` in socks5-client.js), so a lone
  // password is not just ignored at the proxy — the client advertises NO_AUTH.
  // The tunnel would work against an open proxy and fail against the one the
  // credential was entered for.
  const { entries, problems } = await createProxyTable({
    s: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: 1080, password: 'hunter2' },
  })
  assert.equal(entries.size, 0)
  assert.match(problems.get('s'), /密码/)
  assert.match(problems.get('s'), /用户名/)
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

test('an http username without a password is refused', async () => {
  // Basic auth CAN carry a username with an empty password (`alice:`), so nothing
  // would be dropped here. The half-filled credential is still refused: paired
  // credentials are one rule for every transport, and `alice:` is virtually never
  // what someone who typed a username meant.
  const { entries, problems } = await createProxyTable({
    p: { enabled: true, protocol: 'http', host: 'proxy.test', port: 8080, username: 'alice' },
  })
  assert.equal(entries.size, 0)
  assert.match(problems.get('p'), /用户名/)
  assert.match(problems.get('p'), /密码/)
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

test('target-host rules decide proxy vs direct and fail closed', async () => {
  const { entries } = await createProxyTable({
    p: {
      enabled: true,
      protocol: 'http',
      host: 'proxy.test',
      port: 8080,
      onlyHosts: 'Api.Example.COM, .internal.test',
      // Deliberately NOT `localhost`: the built-in loopback rule would make that
      // assertion pass on its own, and this test is about the bypass list.
      bypassHosts: 'bypass.test, *.skip.test',
    },
  })
  const decide = entries.get('p').decide
  assert.equal(decide('api.example.com'), 'proxy', 'an onlyHosts match is proxied, case-insensitively')
  assert.equal(decide('sub.api.example.com'), 'proxy', 'a subdomain is covered by the rule')
  assert.equal(decide('internal.test'), 'proxy', 'a leading dot is accepted as a suffix rule')
  assert.equal(decide('other.test'), 'direct', 'onlyHosts set and not matched goes direct')
  assert.equal(decide('bypass.test'), 'direct', 'bypass beats onlyHosts')
  assert.equal(decide('x.skip.test'), 'direct', 'a *. bypass rule is a suffix match')
  assert.equal(decide(undefined), 'proxy', 'an unparsable target stays proxied (fail-closed)')
  await closeTable(entries)
})

test('without rules every target is proxied', async () => {
  const { entries } = await createProxyTable({
    p: { enabled: true, protocol: 'http', host: 'proxy.test', port: 8080 },
  })
  assert.equal(entries.get('p').decide('anything.invalid'), 'proxy')
  assert.equal(entries.get('p').decide(undefined), 'proxy')
  await closeTable(entries)
})

// ---- loopback and private targets ----

test('a loopback or private target is sent direct', async () => {
  // Forcing a local relay through a forward proxy cannot work — the proxy cannot
  // reach the user's own machine — and the failure reads as "the proxy is
  // broken". These are the addresses that must never be forced through it.
  const { entries } = await createProxyTable({
    p: { enabled: true, protocol: 'http', host: 'proxy.test', port: 8080 },
  })
  const decide = entries.get('p').decide
  const local = [
    'localhost',
    'app.localhost',
    '127.0.0.1',
    '127.9.9.9',
    '::1',
    '[::1]', // what WHATWG URL actually yields for an IPv6 literal
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.1.1',
  ]
  for (const host of local) {
    assert.equal(decide(host), 'direct', `${host} is local and must not be forced through a proxy`)
  }
  await closeTable(entries)
})

test('a public target is still proxied', async () => {
  const { entries } = await createProxyTable({
    p: { enabled: true, protocol: 'http', host: 'proxy.test', port: 8080 },
  })
  const decide = entries.get('p').decide
  // Boundary values around every private range, so an off-by-one cannot pass.
  const publicHosts = [
    'api.deepseek.com',
    'example.com',
    'not-an-ip',
    '11.0.0.1',
    '128.0.0.1',
    '172.15.0.1',
    '172.32.0.1',
    '192.169.0.1',
    '::2',
  ]
  for (const host of publicHosts) {
    assert.equal(decide(host), 'proxy', `${host} must stay on the proxy`)
  }
  await closeTable(entries)
})

test('the loopback rule can be turned off', async () => {
  const { entries } = await createProxyTable(
    { p: { enabled: true, protocol: 'http', host: 'proxy.test', port: 8080 } },
    { localDirect: false },
  )
  assert.equal(entries.get('p').decide('127.0.0.1'), 'proxy', 'turned off, the target goes through the proxy')
  await closeTable(entries)
})

test('the loopback rule does not weaken fail-closed', async () => {
  const { entries } = await createProxyTable({
    p: { enabled: true, protocol: 'http', host: 'proxy.test', port: 8080 },
  })
  assert.equal(entries.get('p').decide(undefined), 'proxy', 'an unparsable target still stays proxied')
  await closeTable(entries)
})

// ---- shared default endpoint (useDefault) ----

test('a route that opts into the shared endpoint takes its address from it', async () => {
  const { entries, problems } = await createProxyTable(
    { p: { enabled: true, useDefault: true, onlyHosts: 'api.example.com' } },
    { defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 7890 } },
  )
  assert.equal(problems.size, 0)
  assert.equal(entries.get('p').proxyOrigin, 'http://127.0.0.1:7890')
  // Only the TRANSPORT moves: the target-host rules stay the route's own.
  assert.equal(entries.get('p').decide('api.example.com'), 'proxy')
  assert.equal(entries.get('p').decide('other.test'), 'direct')
  await closeTable(entries)
})

test('a route without useDefault keeps its own endpoint', async () => {
  const { entries } = await createProxyTable(
    { p: { enabled: true, protocol: 'socks5', host: '10.0.0.1', port: 1080 } },
    { defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 7890 } },
  )
  assert.equal(entries.get('p').proxyOrigin, 'socks5://10.0.0.1:1080')
  await closeTable(entries)
})

test('two providers sharing the shared endpoint still get their own dispatchers', async () => {
  const shared = { protocol: 'http', host: '127.0.0.1', port: 7890 }
  const { entries } = await createProxyTable(
    { a: { enabled: true, useDefault: true }, b: { enabled: true, useDefault: true } },
    { defaultProxy: shared },
  )
  assert.equal(entries.size, 2)
  assert.equal(entries.get('a').proxyOrigin, entries.get('b').proxyOrigin)
  // The endpoint is shared; the DISPATCHER instance never is — one provider's
  // proxy must not be reachable from another provider's call.
  assert.notEqual(entries.get('a').dispatcher, entries.get('b').dispatcher)
  await closeTable(entries)
})

test('opting into an unconfigured shared endpoint is refused, naming the default', async () => {
  const withoutEndpoint = await createProxyTable({ p: { enabled: true, useDefault: true } })
  assert.equal(withoutEndpoint.entries.size, 0)
  assert.match(withoutEndpoint.problems.get('p'), /默认代理/)

  const blank = await createProxyTable(
    { p: { enabled: true, useDefault: true } },
    { defaultProxy: { protocol: 'http', host: '   ', port: 0 } },
  )
  assert.equal(blank.entries.size, 0)
  assert.match(blank.problems.get('p'), /默认代理/)
})

test('the shared-endpoint predicate is the SAME record the Host and browser apply', async () => {
  // One predicate, imported by both halves. A missing host, a host carrying a
  // scheme or path, and an out-of-range port are each reported with the reason;
  // a populated endpoint is fine.
  assert.equal(defaultProxyProblem({ host: '', port: 0 }), '未填写代理地址')
  assert.match(defaultProxyProblem({ host: 'https://1.2.3.4', port: 8080 }) ?? '', /只填主机名或 IP/)
  assert.match(defaultProxyProblem({ host: 'proxy.test/path', port: 8080 }) ?? '', /只填主机名或 IP/)
  assert.match(defaultProxyProblem({ host: 'proxy.test', port: 0 }) ?? '', /端口/)
  assert.equal(defaultProxyProblem({ host: 'proxy.test', port: 8080 }), undefined)
})

test('a shared endpoint carrying a scheme is refused, naming the default block', async () => {
  // The Host rejects this at the DEFAULT block, with a message naming the
  // default — rather than accepting it and only failing later on each card.
  const { entries, problems } = await createProxyTable(
    { p: { enabled: true, useDefault: true } },
    { defaultProxy: { protocol: 'http', host: 'https://1.2.3.4', port: 8080 } },
  )
  assert.equal(entries.size, 0)
  assert.match(problems.get('p'), /使用默认代理/)
  assert.match(problems.get('p'), /只填主机名或 IP/)
})

test('useDefault is irrelevant to a disabled route', async () => {
  const { entries, problems } = await createProxyTable(
    { p: { enabled: false, useDefault: true } },
    { defaultProxy: { host: '', port: 0 } },
  )
  assert.equal(entries.size, 0)
  assert.equal(problems.size, 0, 'a disabled route is not refused for a default it never uses')
})

test('credentials from the shared endpoint reach the route, guards included', async () => {
  // Half-filled credentials must be refused HERE too, which is only possible if
  // the shared username/password actually flowed into the route's own guard.
  const { entries, problems } = await createProxyTable(
    { p: { enabled: true, useDefault: true } },
    { defaultProxy: { protocol: 'http', host: 'proxy.test', port: 8080, username: 'alice' } },
  )
  assert.equal(entries.size, 0)
  assert.match(problems.get('p'), /用户名/)
  assert.match(problems.get('p'), /密码/)
})

test('a complete shared credential builds the dispatcher', async () => {
  const { entries, problems } = await createProxyTable(
    { p: { enabled: true, useDefault: true } },
    {
      defaultProxy: {
        protocol: 'http',
        host: 'proxy.test',
        port: 8080,
        username: 'alice',
        password: 'hunter2',
      },
    },
  )
  assert.equal(problems.size, 0)
  assert.equal(entries.get('p').proxyOrigin, 'http://proxy.test:8080')
  assert.ok(
    !JSON.stringify(entries.get('p')).includes('hunter2'),
    'the shared credential must still never appear in a route entry',
  )
  await closeTable(entries)
})

// ---- building a disabled route for the connection self-check ----

test('normalizeRoute validates a disabled route only when explicitly asked', () => {
  const incomplete = { enabled: false, protocol: 'http', host: '', port: 0 }
  // Nothing was asked of a disabled route, so a half-typed endpoint is not a
  // problem to report.
  assert.doesNotThrow(() => normalizeRoute('p', incomplete))
  // The self-check DOES ask: it applies exactly the validation routing would.
  assert.throws(
    () => normalizeRoute('p', incomplete, { requireEnabled: false }),
    /未填写代理地址/,
  )
  assert.throws(
    () => normalizeRoute('p', { enabled: false, host: '127.0.0.1', port: 0 }, { requireEnabled: false }),
    /端口无效/,
  )
  assert.doesNotThrow(() =>
    normalizeRoute('p', { enabled: false, host: '127.0.0.1', port: 7890 }, { requireEnabled: false }),
  )
})

test('buildRouteEntry builds a disabled route the self-check can run', async () => {
  const defaultProxy = normalizeDefaultProxy({ host: '', port: 0 })
  const built = buildRouteEntry(
    'p',
    { enabled: false, protocol: 'http', host: '127.0.0.1', port: 7890 },
    { defaultProxy, requireEnabled: false, localDirect: true },
  )
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(built.entry.proxyOrigin, 'http://127.0.0.1:7890')
  await built.entry.dispatcher.close()
})

test('buildRouteEntry reports the reason a disabled route cannot be built', () => {
  const defaultProxy = normalizeDefaultProxy({ host: '', port: 0 })
  // Half-filled credentials must be refused HERE too: the self-check runs the
  // same guards as routing, so a setting that would be refused is not reported
  // as checked-and-fine.
  const refused = buildRouteEntry(
    'p',
    { enabled: false, protocol: 'http', host: 'proxy.test', port: 8080, password: 'secret' },
    { defaultProxy, requireEnabled: false, localDirect: true },
  )
  assert.equal(refused.ok, false)
  if (refused.ok) return
  assert.match(refused.problem, /没有用户名/)
})

test('buildRouteEntry resolves the shared endpoint for a disabled route too', async () => {
  const defaultProxy = normalizeDefaultProxy({ protocol: 'http', host: '127.0.0.1', port: 7890 })
  const built = buildRouteEntry(
    'p',
    { enabled: false, useDefault: true },
    { defaultProxy, requireEnabled: false, localDirect: true },
  )
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(built.entry.proxyOrigin, 'http://127.0.0.1:7890')
  await built.entry.dispatcher.close()
})

