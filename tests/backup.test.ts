// N17: configuration backup and restore. The pure functions are what the page
// uses, so these tests are the contract: an export the import rejects would only
// be found by a user who had already lost their configuration.

import test from 'node:test'
import assert from 'node:assert/strict'

const {
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
    },
  },
  defaultProxy: { protocol: 'http', host: '127.0.0.1', port: 7890, password: 'defaultpass' },
  localDirect: false,
  testUrl: 'https://echo.example/ip',
}

test('N17: an export carries every field the restore needs', () => {
  const document = buildBackup(SOURCE, { includePasswords: true, now: new Date('2026-10-27T08:00:00Z') })
  assert.equal(document.version, 1)
  assert.equal(document.exportedAt, '2026-10-27T08:00:00.000Z')
  assert.equal(document.localDirect, false)
  assert.equal(document.testUrl, 'https://echo.example/ip')
  assert.deepEqual(Object.keys(document.providers).sort(), ['old-style', 'openai', 'sensenova'])
  assert.deepEqual(document.proxyProfiles['HK-Proxy'], SOURCE.proxyProfiles['HK-Proxy'])
  assert.equal(document.providers.sensenova.password, 'hunter2')
  assert.equal(document.defaultProxy.password, 'defaultpass')
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
  assert.equal(parsed.document.localDirect, true)
  assert.equal(parsed.document.testUrl, 'https://api.ipify.org?format=json')
  assert.deepEqual(parsed.document.defaultProxy, {
    protocol: 'http',
    host: '',
    port: 0,
    username: '',
    password: '',
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
    { proxyProfiles: { x: { host: 1 } } },
    { defaultProxy: { port: 'x' } },
    { providers: {}, localDirect: 'true' },
    { providers: {}, testUrl: 42 },
  ]
  for (const value of cases) {
    const parsed = parseBackup(JSON.stringify(value))
    assert.equal(parsed.ok, false, JSON.stringify(value))
  }
})

test('N17: a restore writes every top-level section in one operation list', () => {
  const parsed = parseBackup(JSON.stringify(buildBackup(SOURCE)))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const ops = backupOps(parsed.document)
  assert.deepEqual(
    ops.map(op => op.path),
    [['providers'], ['proxyProfiles'], ['defaultProxy'], ['localDirect'], ['testUrl']],
  )
  // Dictionaries are written WHOLE: a per-key write could only add entries, so a
  // restore could never remove a preset the backup does not contain.
  assert.deepEqual(Object.keys(ops[1].value), ['HK-Proxy'])
})

test('N17: the counts describe what a restore would replace', () => {
  const parsed = parseBackup(JSON.stringify(buildBackup(SOURCE)))
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.deepEqual(backupCounts(parsed.document), { providers: 3, profiles: 1, enabled: 3 })
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
  })
  // The Host normalizes (trims) what the schema fills in; the backup copy must
  // reach the same value, or a restored file would differ from a saved one.
  assert.deepEqual(normalizeDefaultProxy({ host: '  host.test  ', username: ' bob ' }), {
    protocol: 'http',
    host: 'host.test',
    port: 0,
    username: 'bob',
    password: '',
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
  })
  assert.equal(document.defaultProxy.username, 'x', 'the same trim the schema applies')
})
