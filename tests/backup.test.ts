// N17: configuration backup and restore. The pure functions are what the page
// uses, so these tests are the contract: an export the import rejects would only
// be found by a user who had already lost their configuration.

import test from 'node:test'
import assert from 'node:assert/strict'

const {
  BACKUP_VERSION,
  backupCounts,
  backupFileName,
  backupOps,
  buildBackup,
  parseBackup,
  validateEnabledRoutes,
} = await import('../lib/index.js')

/** The schema itself, used only to prove the local defaults still agree. */
const schema = await import('../lib/index.js')

const SOURCE = {
  providers: {
    sensenova: {
      enabled: true,
      profileId: '',
      useDefault: false,
      protocol: 'socks5',
      host: '10.0.0.1',
      port: 1080,
      username: 'alice',
      password: 'hunter2',
      onlyHosts: 'api.example.com',
      // SOCKS5 over TLS (N22): the flags travel with the endpoint, and the
      // password must still be the only redacted value.
      proxyTls: true,
      proxyTlsRejectUnauthorized: false,
    },
    openai: { enabled: true, profileId: 'HK-Proxy', protocol: 'http', host: '', port: 0 },
    'old-style': { enabled: true, useDefault: true },
  },
  proxyProfiles: {
    'HK-Proxy': {
      protocol: 'http',
      host: '127.0.0.1',
      port: 7891,
      username: 'bob',
      password: 's3cret',
      proxyTls: false,
      proxyTlsRejectUnauthorized: true,
    },
    'TLS-Pool': {
      protocol: 'socks5',
      host: 'tls.example',
      port: 1081,
      username: 'carol',
      password: 'tls-secret',
      proxyTls: true,
      proxyTlsRejectUnauthorized: true,
    },
  },
  defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 7890, password: 'defaultpass' },
  localDirect: false,
  testUrl: 'https://echo.example/ip',
  heartbeatEnabled: true,
  heartbeatInterval: 900,
  heartbeatConsecutiveFails: 3,
  searchProxyStrategy: 'dedicated',
  searchProxyProfileId: 'TLS-Pool',
}

test('N17: an export carries every field the restore needs', () => {
  const document = buildBackup(SOURCE, { includePasswords: true, now: new Date('2026-10-27T08:00:00Z') })
  assert.equal(document.version, BACKUP_VERSION)
  assert.equal(document.version, 2)
  assert.equal(document.exportedAt, '2026-10-27T08:00:00.000Z')
  assert.equal(document.localDirect, false)
  assert.equal(document.testUrl, 'https://echo.example/ip')
  assert.deepEqual(Object.keys(document.providers).sort(), ['old-style', 'openai', 'sensenova'])
  assert.deepEqual(document.proxyProfiles['HK-Proxy'], SOURCE.proxyProfiles['HK-Proxy'])
  assert.deepEqual(document.proxyProfiles['TLS-Pool'], SOURCE.proxyProfiles['TLS-Pool'])
  assert.equal(document.providers.sensenova.password, 'hunter2')
  assert.equal(document.defaultProxy.password, 'defaultpass')
  // 1.1.0 sections travel with the file, or a restore would silently keep the
  // previous machine's heartbeat and split strategy.
  assert.equal(document.heartbeatEnabled, true)
  assert.equal(document.heartbeatInterval, 900)
  assert.equal(document.heartbeatConsecutiveFails, 3)
  assert.equal(document.searchProxyStrategy, 'dedicated')
  assert.equal(document.searchProxyProfileId, 'TLS-Pool')
})

test('N25: a redacted export covers the SOCKS5-over-TLS endpoints too', () => {
  // N22 added a second axis to every endpoint (proxyTls + the insecure switch).
  // Redaction is not allowed to notice only the endpoints that existed before it,
  // so the TLS-enabled route and preset are checked explicitly.
  const document = buildBackup(SOURCE, { includePasswords: false })
  assert.equal(document.providers.sensenova.password, '')
  assert.equal(document.proxyProfiles['TLS-Pool'].password, '')
  assert.equal(document.proxyProfiles['HK-Proxy'].password, '')
  assert.equal(document.defaultProxy.password, '')
  // The TLS flags are configuration, not secrets, and must survive.
  assert.equal(document.providers.sensenova.proxyTls, true)
  assert.equal(document.providers.sensenova.proxyTlsRejectUnauthorized, false)
  assert.equal(document.proxyProfiles['TLS-Pool'].proxyTls, true)
  assert.equal(document.proxyProfiles['TLS-Pool'].proxyTlsRejectUnauthorized, true)
  for (const secret of ['hunter2', 's3cret', 'tls-secret', 'defaultpass']) {
    assert.equal(JSON.stringify(document).includes(secret), false, `${secret} must not be exported`)
  }
})

test('N17: a redacted export empties every password and nothing else', () => {
  const document = buildBackup(SOURCE, { includePasswords: false })
  assert.equal(document.providers.sensenova.password, '')
  assert.equal(document.proxyProfiles['HK-Proxy'].password, '')
  assert.equal(document.defaultProxy.password, '')
  // Everything that is not a password must survive untouched.
  assert.equal(document.providers.sensenova.username, 'alice')
  assert.equal(document.providers.sensenova.host, '10.0.0.1')
  assert.equal(document.providers.sensenova.onlyHosts, 'api.example.com')
  assert.equal(document.proxyProfiles['HK-Proxy'].username, 'bob')
  assert.equal(document.defaultProxy.host, '127.0.0.1')
  assert.equal(JSON.stringify(document).includes('hunter2'), false)
  assert.equal(JSON.stringify(document).includes('s3cret'), false)
  assert.equal(JSON.stringify(document).includes('defaultpass'), false)
})

test('N17: redaction is the default when no option is given', () => {
  assert.equal(buildBackup(SOURCE).providers.sensenova.password, '')
})

test('N17: an export round-trips through parseBackup unchanged', () => {
  const document = buildBackup(SOURCE, { includePasswords: true })
  const parsed = parseBackup(JSON.stringify(document))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.document, document)
})

test('N17: a 0.8.0 backup without proxyProfiles still imports', () => {
  const legacy = {
    providers: { sensenova: { enabled: true, useDefault: true } },
    defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 7890 },
    localDirect: true,
    testUrl: 'https://api.ipify.org?format=json',
  }
  const parsed = parseBackup(JSON.stringify(legacy))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(parsed.document.proxyProfiles, {})
  assert.equal(parsed.document.providers.sensenova.profileId, '')
  assert.equal(parsed.document.providers.sensenova.useDefault, true)
})

test('N25: every pre-1.1.0 backup version still imports and gains the 1.1.0 defaults', () => {
  // 0.8.0: no version, no proxyProfiles, no TLS flags, no 1.1.0 sections.
  const v080 = {
    providers: { a: { enabled: true, host: '10.0.0.1', port: 1080 } },
    defaultProxy: { host: '127.0.0.1', port: 7890 },
    localDirect: true,
    testUrl: 'https://api.ipify.org?format=json',
  }
  // 1.0.0: `version: 1`, presets present, TLS flags present.
  const v100 = {
    version: 1,
    exportedAt: '2026-10-01T00:00:00.000Z',
    providers: {
      a: { enabled: true, protocol: 'socks5', host: '10.0.0.1', port: 1080, proxyTls: true },
    },
    proxyProfiles: { HK: { host: '127.0.0.1', port: 7891, proxyTls: true } },
    defaultProxy: { host: '127.0.0.1', port: 7890 },
    localDirect: true,
    testUrl: 'https://api.ipify.org?format=json',
  }

  for (const [label, file] of [['0.8.0', v080], ['1.0.0', v100]] as const) {
    const parsed = parseBackup(JSON.stringify(file))
    assert.equal(parsed.ok, true, label)
    if (!parsed.ok) continue
    const document = parsed.document
    assert.equal(document.version, BACKUP_VERSION, `${label} is upgraded in memory`)
    // The 1.1.0 defaults are the SAFE defaults: the background prober stays off
    // and search keeps the pre-1.1.0 routing.
    assert.equal(document.heartbeatEnabled, false, label)
    assert.equal(document.heartbeatInterval, 300, label)
    assert.equal(document.heartbeatConsecutiveFails, 2, label)
    assert.equal(document.searchProxyStrategy, 'inherit', label)
    assert.equal(document.searchProxyProfileId, '', label)
    // Everything the file DID carry is preserved.
    assert.equal(document.providers.a.enabled, true, label)
    assert.equal(document.defaultProxy.host, '127.0.0.1', label)
    assert.equal(document.testUrl, 'https://api.ipify.org?format=json', label)
  }

  const upgraded = parseBackup(JSON.stringify(v100))
  assert.equal(upgraded.ok, true)
  if (upgraded.ok) {
    assert.equal(upgraded.document.providers.a.proxyTls, true, 'a 1.0.0 TLS flag survives')
    assert.equal(upgraded.document.proxyProfiles.HK.proxyTls, true)
    assert.equal(upgraded.document.exportedAt, '2026-10-01T00:00:00.000Z')
  }
})

test('N25: a file from a NEWER version is refused instead of half applied', () => {
  const future = parseBackup(
    JSON.stringify({ version: BACKUP_VERSION + 1, providers: {}, defaultProxy: {} }),
  )
  assert.equal(future.ok, false)
  if (!future.ok) {
    assert.match(future.error, /更新版本/)
    assert.match(future.error, new RegExp(String(BACKUP_VERSION + 1)))
  }
  const bogus = parseBackup(JSON.stringify({ version: '1', providers: {} }))
  assert.equal(bogus.ok, false)
  if (!bogus.ok) assert.match(bogus.error, /version/)
})

test('N17: missing optional fields are filled with schema defaults', () => {
  const parsed = parseBackup(JSON.stringify({ providers: { p: { enabled: true } } }))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const route = parsed.document.providers.p
  assert.equal(route.profileId, '')
  assert.equal(route.protocol, 'http')
  assert.equal(route.host, '')
  assert.equal(route.port, 0)
  assert.equal(route.onlyHosts, '')
  assert.equal(route.proxyTls, false)
  assert.equal(route.proxyTlsRejectUnauthorized, true)
  assert.equal(parsed.document.localDirect, true)
  assert.equal(parsed.document.testUrl, 'https://api.ipify.org?format=json')
  assert.equal(parsed.document.heartbeatEnabled, false)
  assert.equal(parsed.document.searchProxyStrategy, 'inherit')
  assert.deepEqual(parsed.document.defaultProxy, {
    protocol: 'http',
    host: '',
    port: 0,
    username: '',
    password: '',
    proxyTls: false,
    proxyTlsRejectUnauthorized: true,
  })
})

test('N17: a malformed file is refused with a reason, never thrown on', () => {
  for (const text of ['', '{', '[]', 'null', '"x"']) {
    const parsed = parseBackup(text)
    assert.equal(parsed.ok, false, text)
    assert.ok(parsed.error.length > 0, text)
  }
})

test('N17: a file that is not a proxy configuration is refused', () => {
  const parsed = parseBackup(JSON.stringify({ unrelated: true }))
  assert.equal(parsed.ok, false)
  assert.match(parsed.error, /providers/)
})

test('N17: wrong types are refused rather than silently coerced', () => {
  const cases = [
    { providers: [] },
    { providers: { p: 'nope' } },
    { providers: { p: { enabled: 'yes' } } },
    { providers: { p: { port: '7890' } } },
    { providers: { p: { protocol: 'ftp' } } },
    { providers: { p: { onlyHosts: 5 } } },
    { providers: { p: { proxyTls: 'yes' } } },
    { providers: { p: { proxyTlsRejectUnauthorized: 'no' } } },
    { proxyProfiles: { x: { host: 1 } } },
    { proxyProfiles: { x: { proxyTls: 1 } } },
    { defaultProxy: { port: 'x' } },
    { providers: {}, localDirect: 'true' },
    { providers: {}, testUrl: 42 },
    // 1.1.0 sections: same rule — a known key with the wrong type is an error.
    { providers: {}, heartbeatEnabled: 'true' },
    { providers: {}, heartbeatInterval: '300' },
    { providers: {}, heartbeatConsecutiveFails: '2' },
    { providers: {}, searchProxyStrategy: 'inherit ' },
    { providers: {}, searchProxyProfileId: 5 },
  ]
  for (const value of cases) {
    const parsed = parseBackup(JSON.stringify(value))
    assert.equal(parsed.ok, false, JSON.stringify(value))
  }
})

test('N25: an unknown split strategy in a backup is refused, not degraded to inherit', () => {
  // The settings loader must survive a value written by a newer build (it falls
  // back to `inherit`). A RESTORE is an explicit, confirmed overwrite instead, so
  // an unknown strategy means the file and this build disagree about what will
  // happen — that is an error, not something to silently reinterpret.
  const parsed = parseBackup(
    JSON.stringify({ providers: {}, searchProxyStrategy: 'proxy-if-chinese' }),
  )
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.error, /searchProxyStrategy/)
})

test('N17: a restore writes every top-level section in one operation list', () => {
  const parsed = parseBackup(JSON.stringify(buildBackup(SOURCE)))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const ops = backupOps(parsed.document)
  assert.deepEqual(
    ops.map(op => op.path),
    [
      ['providers'],
      ['proxyProfiles'],
      ['defaultProxy'],
      ['localDirect'],
      ['testUrl'],
      // 1.1.0: a restore replaces the WHOLE configuration, so the global
      // switches are part of the same single operation list.
      ['heartbeatEnabled'],
      ['heartbeatInterval'],
      ['heartbeatConsecutiveFails'],
      ['searchProxyStrategy'],
      ['searchProxyProfileId'],
    ],
  )
  // Dictionaries are written WHOLE: a per-key write could only add entries, so a
  // restore could never remove a preset the backup does not contain.
  assert.deepEqual(Object.keys(ops[1].value), ['HK-Proxy', 'TLS-Pool'])
  assert.deepEqual(
    ops.slice(5).map(op => op.value),
    [true, 900, 3, 'dedicated', 'TLS-Pool'],
    'and the 1.1.0 values are the ones the file carried',
  )
})

test('N17: the counts describe what a restore would replace', () => {
  const parsed = parseBackup(JSON.stringify(buildBackup(SOURCE)))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(backupCounts(parsed.document), { providers: 3, profiles: 2, enabled: 3 })
})

test('N17: the file name carries the local date', () => {
  // Constructed from local components, so the name matches the user's calendar.
  const name = backupFileName(new Date(2026, 9, 27, 23, 30))
  assert.equal(name, 'dsh-proxy-backup-2026-10-27.json')
  assert.equal(backupFileName(new Date(2026, 0, 5)), 'dsh-proxy-backup-2026-01-05.json')
})

test('N17: a disabled route needs no endpoint, an enabled own-endpoint route does', () => {
  const disabled = parseBackup(
    JSON.stringify({ providers: { p: { enabled: false, host: '', port: 0 } } }),
  )
  assert.equal(disabled.ok, true)
  if (disabled.ok) assert.equal(validateEnabledRoutes(disabled.document), undefined)

  const enabled = parseBackup(
    JSON.stringify({ providers: { p: { enabled: true, host: '', port: 0 } } }),
  )
  assert.equal(enabled.ok, true)
  if (!enabled.ok) return
  const problem = validateEnabledRoutes(enabled.document)
  assert.equal(problem?.provider, 'p')
})

test('N17: a route bound to a preset or the default needs no fields of its own', () => {
  const parsed = parseBackup(
    JSON.stringify({
      providers: {
        a: { enabled: true, profileId: 'HK' },
        b: { enabled: true, useDefault: true },
      },
      proxyProfiles: { HK: { host: '127.0.0.1', port: 7891 } },
      defaultProxy: { host: '127.0.0.1', port: 7890 },
    }),
  )
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(validateEnabledRoutes(parsed.document), undefined)
})

test('N17: the backup defaults agree with the settings schema', () => {
  // `src/backup.ts` keeps a local, browser-safe copy of the endpoint defaults so
  // the client bundle never pulls in the schemastery loader. This test is what
  // keeps that copy honest.
  const { Config, normalizeDefaultProxy } = schema
  const read = value => (typeof value?.get === 'function' ? value.get() : value)
  const fromSchema = read(Config({ providers: {}, defaultProxy: {} }).defaultProxy)
  assert.deepEqual(fromSchema, {
    protocol: 'http',
    host: '',
    port: 0,
    username: '',
    password: '',
    proxyTls: false,
    proxyTlsRejectUnauthorized: true,
  })
  // The Host normalizes (trims) what the schema fills in; the backup copy must
  // reach the same value, or a restored file would differ from a saved one.
  assert.deepEqual(normalizeDefaultProxy({ host: '  host.test  ', username: ' bob ' }), {
    protocol: 'http',
    host: 'host.test',
    port: 0,
    username: 'bob',
    password: '',
    proxyTls: false,
    proxyTlsRejectUnauthorized: true,
  })

  const document = buildBackup(
    { providers: {}, proxyProfiles: { p: { host: '  h.test  ' } }, defaultProxy: { username: ' x ' } },
    { includePasswords: true },
  )
  assert.deepEqual(document.proxyProfiles.p, {
    protocol: 'http',
    host: 'h.test',
    port: 0,
    username: '',
    password: '',
    proxyTls: false,
    proxyTlsRejectUnauthorized: true,
  })
  assert.equal(document.defaultProxy.username, 'x', 'the same trim the schema applies')

  // The heartbeat trio and the split pair are ALSO copied here for bundling
  // reasons, so the same drift check applies to them (N25).
  // Every one of these is a Volatile field, so each is unwrapped on its own
  const defaults = Config({ providers: {} })
  assert.deepEqual(
    read(defaults.heartbeatEnabled),
    false,
    'heartbeat stays off by default: no unsolicited background traffic',
  )
  assert.equal(read(defaults.heartbeatInterval), 300)
  assert.equal(read(defaults.heartbeatConsecutiveFails), 2)
  assert.equal(read(defaults.searchProxyStrategy), 'inherit')
  assert.equal(read(defaults.searchProxyProfileId), '')

  const { normalizeHeartbeatConfig } = schema
  const empty = buildBackup({ providers: {} })
  assert.deepEqual(
    {
      heartbeatEnabled: empty.heartbeatEnabled,
      heartbeatInterval: empty.heartbeatInterval,
      heartbeatConsecutiveFails: empty.heartbeatConsecutiveFails,
    },
    normalizeHeartbeatConfig(undefined),
    'an empty backup must round-trip to exactly the schema default',
  )
  // And the normalizer clamps the same way, so a hand-edited backup cannot arm a
  // 1-second prober by writing `heartbeatInterval: 1`.
  const clamped = buildBackup({
    providers: {},
    heartbeatEnabled: true,
    heartbeatInterval: 1,
    heartbeatConsecutiveFails: 0,
  })
  const normalized = normalizeHeartbeatConfig({
    heartbeatEnabled: true,
    heartbeatInterval: 1,
    heartbeatConsecutiveFails: 0,
  })
  assert.deepEqual(
    {
      heartbeatEnabled: clamped.heartbeatEnabled,
      heartbeatInterval: clamped.heartbeatInterval,
      heartbeatConsecutiveFails: clamped.heartbeatConsecutiveFails,
    },
    normalized,
  )
  assert.equal(clamped.heartbeatInterval, 300)
  assert.equal(clamped.heartbeatConsecutiveFails, 2)
})
