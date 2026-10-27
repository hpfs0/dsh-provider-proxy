// N15: detecting a forward proxy from the Host environment, and the built-in
// common-client presets. The endpoint is published over an HTTP endpoint, so
// the credential tests here are the security contract, not a nicety.

import test from 'node:test'
import assert from 'node:assert/strict'

const { detectProxyEnv, parseProxyEnvValue, PROXY_CLIENT_PRESETS, proxyClientPreset } =
  await import('../lib/index.js')

test('N15: a full URL is parsed into an endpoint', () => {
  assert.deepEqual(parseProxyEnvValue('http://127.0.0.1:7890'), {
    protocol: 'http',
    host: '127.0.0.1',
    port: 7890,
    hadCredentials: false,
  })
})

test('N15: a bare host:port (the V2Ray spelling) is accepted', () => {
  assert.deepEqual(parseProxyEnvValue('127.0.0.1:10809'), {
    protocol: 'http',
    host: '127.0.0.1',
    port: 10809,
    hadCredentials: false,
  })
})

test('N15: socks5 and the socks:// alias both land on socks5', () => {
  assert.equal(parseProxyEnvValue('socks5://127.0.0.1:10808')?.protocol, 'socks5')
  assert.equal(parseProxyEnvValue('socks://127.0.0.1:10808')?.protocol, 'socks5')
})

test('N15: credentials are DROPPED and only their presence is reported', () => {
  const parsed = parseProxyEnvValue('http://alice:hunter2@proxy.test:8080')
  assert.deepEqual(parsed, {
    protocol: 'http',
    host: 'proxy.test',
    port: 8080,
    hadCredentials: true,
  })
  // The whole point: nothing credential-shaped may reach the payload.
  assert.equal(JSON.stringify(parsed).includes('alice'), false)
  assert.equal(JSON.stringify(parsed).includes('hunter2'), false)
})

test('N15: an explicit :80 survives, since WHATWG URL drops a default port', () => {
  assert.equal(parseProxyEnvValue('http://proxy.test:80')?.port, 80)
  assert.equal(parseProxyEnvValue('https://proxy.test:443')?.port, 443)
})

test('N15: an IPv6 literal is unbracketed for the host field', () => {
  assert.equal(parseProxyEnvValue('http://[::1]:7890')?.host, '::1')
})

test('N15: malformed or unsupported values are skipped, never thrown on', () => {
  for (const raw of ['', '   ', 'not a proxy', 'ftp://proxy.test:21', 'http://', '://x:1']) {
    assert.equal(parseProxyEnvValue(raw), undefined, raw)
  }
  assert.equal(parseProxyEnvValue(undefined), undefined)
})

test('N15: the first comma-separated candidate wins, as curl does', () => {
  assert.equal(parseProxyEnvValue('http://first.test:1111, http://second.test:2222')?.port, 1111)
})

test('N15: detection prefers HTTPS_PROXY, then HTTP_PROXY, then ALL_PROXY', () => {
  const detected = detectProxyEnv({
    HTTPS_PROXY: 'http://https-proxy.test:1111',
    HTTP_PROXY: 'http://http-proxy.test:2222',
    ALL_PROXY: 'socks5://all-proxy.test:3333',
  })
  assert.equal(detected?.source, 'HTTPS_PROXY')
  assert.equal(detected?.port, 1111)

  assert.equal(
    detectProxyEnv({ HTTP_PROXY: 'http://http-proxy.test:2222', ALL_PROXY: 'socks5://x.test:1' })?.source,
    'HTTP_PROXY',
  )
  assert.equal(detectProxyEnv({ ALL_PROXY: 'socks5://x.test:1' })?.source, 'ALL_PROXY')
})

test('N15: an unusable variable is skipped instead of published as a broken preset', () => {
  // No port at all, then an out-of-range port, then a usable one.
  const detected = detectProxyEnv({
    HTTPS_PROXY: 'http://proxy.test',
    HTTP_PROXY: 'http://proxy.test:99999',
    ALL_PROXY: 'http://proxy.test:7890',
  })
  assert.equal(detected?.source, 'ALL_PROXY')
  assert.equal(detected?.port, 7890)
})

test('N15: no variable at all detects nothing', () => {
  assert.equal(detectProxyEnv({}), undefined)
})

test('N15: the common-client presets use each client real default port', () => {
  const byId = new Map(PROXY_CLIENT_PRESETS.map(preset => [preset.id, preset]))
  assert.equal(byId.get('clash').port, 7890)
  assert.equal(byId.get('clash-verge').port, 7897)
  assert.equal(byId.get('v2ray-http').port, 10809)
  assert.equal(byId.get('v2ray-socks').port, 10808)
  assert.equal(byId.get('v2ray-socks').protocol, 'socks5')
  for (const preset of PROXY_CLIENT_PRESETS) {
    assert.equal(preset.host, '127.0.0.1', `${preset.id} is a local client`)
    assert.equal(proxyClientPreset(preset.id), preset)
  }
  assert.equal(proxyClientPreset('nope'), undefined)
})
