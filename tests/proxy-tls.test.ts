import test from 'node:test'
import assert from 'node:assert/strict'
import tls from 'node:tls'
import net from 'node:net'
import { createServer } from 'node:http'

import {
  DefaultProxy,
  ProviderProxyRoute,
  normalizeRoute,
  normalizeDefaultProxy,
  withEndpoint,
  endpointSummary,
  createProxyTable,
  routeFingerprint,
  routeStateDecision,
  buildBackup,
  parseBackup,
} from '../lib/index.js'

// 2048-bit RSA self-signed test certificate & private key for 127.0.0.1 (valid until 2036)
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCvDQlsWF727/Dm
k8Wtej//60XfX4u6SS6dlwx0drrjCLCNKX9l0fmaUOPVetnqNqjxyjYlOKrTz1bn
TJ/12/t4anOBoCmR62rN9WiMf42wQfu9InnMbTgVcNBLEHea+KCs1L5CpSWYVhA2
2/j2OkOZ6QGlTnOKQ6WrDVl0VzT2OPKLMJaoQH4/i35OWvVMdKaoHbLSSrxsJUKy
/Fqljhqw41mRpXbpGApQ61PEGd104hohmJgPPtpcNw3prAXBxIzDwilMjN16I4ND
62mu1VB5Hf+FYSO53RULdsF1k2+ocWWRn9vVZeCun1KEtzmyTY13jv95A5H0pBjQ
QZLt9e5xAgMBAAECggEAHx0JljzU0D5QiqMsSQvIEVQ/jJbeboNwaik9WPv7drwG
KWj9UFs0arXC8SBPWD5T4/oFirMaReB9+UmYyunJNhtxoVIW4W0/BBGA/ivzwqbP
uEvG60tkYwc0torcP2q+oEmF8bGJz5xIcH/DrfwoJNSR6tBZX/NrIE6UnkWbz8F+
ktvpzaa8VauWXK2aMPI70z1VI9AIe4Wf6RiaUYNGTNxeOUAjReEd0/DwH86QK4rU
WzlyQFCZw29xAtmo1k/UP8Ae7uEfTuYyzD1FEDVZQ2R6h2nxZLN9fYTwFSr3v4Ks
yiRzUHWMzJFeXuGrKFpr0qCLHrt3q87sf/I3KxEjOwKBgQDxF+wbxN83Z3Blikjo
v2fe0JknUlW65sj5Ts5M+34qE57Fx/p70tccdgNt8Z1/FGq9UpM8T2mXK/Fzds8X
L2zGpx/PN2TKn2zka7sdms4cv3m1iqwp0J1bp73vQGqgvoQPtHhPUihh+Ey7W82H
b9SgWsqcdZk0PVoYry2OOBMRkwKBgQC538eUqngwKnd3N7FUrb4TIsv5G3lbPbwe
hSrNeksEtZqSXh14Sjtadu0geUE3xZJitVWFNA/lRMtCEotyoe6USb64YuNkIteM
frfu3OlbmObN6PuoowByrZanz8GNAUeIoowd791qn1/3AeF3DYzBtOJpu3XqyrFX
SDyTGAHSawKBgQDayCqqyG0HigalHmgrTgakXAefd0f045ldI/ZyRYaoCEX8lQzp
cNtkKHPUQX365Dw4scaK5EWduXLSpO4ozBCZ9O8Yy9vbQ/E9F8Ylh2WjEN8Rr1Ws
XHNvyTjC9GHOnRSaa9sBoDylKv32x8grL4B0Q++5K75reYFZBR8CAEDNoQKBgB0a
00+OGd/A5o/+YoAV7ItmiXXqPWhyFEDbLUabfZ+xKBD/N7IcPYr+0EajdfjbsP5P
0qJW8p491W31JWy/unHx0jFhGqYVZpcTSI3YfZngKVPYxX80dt9+GvcP6wi/SIo2
maYeZxdI+WfeHYXc00uJnWJc/ivTrU0zfHiz66UdAoGAAzXHRJ7IyxL2YP1JTAtL
B9VckvBo1EVo3twFu3OHY4bl5iWkxYNpyxydJXQy7wo+XxvHD7E8YhBMUnpCLFVy
u4d6dtAEzFKQqCxLi0Ew3JtDqEI0//zvXgDkrXdTXpipYefb/LzfuJ9R7m5JpotI
03FxWQYIg3lYjhnw0jy6Pm4=
-----END PRIVATE KEY-----`

const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUJy8KWAz/ZJHscHIOUvjskEAVee8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTEwMzAzMDMzMloXDTM2MTAz
MTAzMDMzMlowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEArw0JbFhe9u/w5pPFrXo//+tF31+LukkunZcMdHa64wiw
jSl/ZdH5mlDj1XrZ6jao8co2JTiq089W50yf9dv7eGpzgaApketqzfVojH+NsEH7
vSJ5zG04FXDQSxB3mvigrNS+QqUlmFYQNtv49jpDmekBpU5zikOlqw1ZdFc09jjy
izCWqEB+P4t+Tlr1THSmqB2y0kq8bCVCsvxapY4asONZkaV26RgKUOtTxBnddOIa
IZiYDz7aXDcN6awFwcSMw8IpTIzdeiODQ+tprtVQeR3/hWEjud0VC3bBdZNvqHFl
kZ/b1WXgrp9ShLc5sk2Nd47/eQOR9KQY0EGS7fXucQIDAQABo1MwUTAdBgNVHQ4E
FgQUMaRG+Me1lwOZkNKkiP/4NdDZlxgwHwYDVR0jBBgwFoAUMaRG+Me1lwOZkNKk
iP/4NdDZlxgwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAPZqT
O3ObUR41kheLhhNth1+CI1VseWvWQSH1Rh8yBMxB/gTfWBKNIeo37Bcp5v2KCyUt
XlzYOWl9VO2opjHKCQdOCmuH2PpwtiUUZOVvp0QxB86cEfy8gH+/tZtEEN/fczEc
MRY3CT4SK2opNCYW7PTH8b5JdsogCG6Uut8KfSYAN1gseo5NYc+83Q2pNCSN5oAL
cfME9v7qcs76FhurWN2GFNwlzaUXGV/HIhCw9pK0EUzRMxiFwU2BHAP1FMWSAsWj
deRifJcbtYCnby8/rhKHKiQ1qyWdePFZcUgO9q4TAB5wNpoiWRc6SarFJOabPyAu
C2b0aS7vNvZnYQWCYQ==
-----END CERTIFICATE-----`

test('N22: schema defaults for proxyTls and proxyTlsRejectUnauthorized', () => {
  const defaultRoute = ProviderProxyRoute({})
  assert.equal(defaultRoute.proxyTls, false)
  assert.equal(defaultRoute.proxyTlsRejectUnauthorized, true)

  const defaultProxy = DefaultProxy({})
  assert.equal(defaultProxy.proxyTls, false)
  assert.equal(defaultProxy.proxyTlsRejectUnauthorized, true)
})

test('N22: normalizeRoute and normalizeDefaultProxy preserve proxyTls flags', () => {
  const route = normalizeRoute('test-provider', {
    enabled: true,
    protocol: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    proxyTls: true,
    proxyTlsRejectUnauthorized: false,
  })
  assert.equal(route.proxyTls, true)
  assert.equal(route.proxyTlsRejectUnauthorized, false)

  const def = normalizeDefaultProxy({
    protocol: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    proxyTls: true,
    proxyTlsRejectUnauthorized: false,
  })
  assert.equal(def.proxyTls, true)
  assert.equal(def.proxyTlsRejectUnauthorized, false)
})

test('N22: withEndpoint copies proxyTls flags to target route', () => {
  const base = { protocol: 'http' as const, host: '', port: 0 }
  const endpoint = {
    protocol: 'socks5' as const,
    host: 'proxy.internal',
    port: 1080,
    proxyTls: true,
    proxyTlsRejectUnauthorized: false,
  }
  const merged = withEndpoint(base, endpoint)
  assert.equal(merged.protocol, 'socks5')
  assert.equal(merged.proxyTls, true)
  assert.equal(merged.proxyTlsRejectUnauthorized, false)
})

test('N22: routeFingerprint incorporates proxyTls and proxyTlsRejectUnauthorized', () => {
  const fp1 = routeFingerprint({
    protocol: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    proxyTls: false,
    proxyTlsRejectUnauthorized: true,
  })
  const fp2 = routeFingerprint({
    protocol: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    proxyTls: true,
    proxyTlsRejectUnauthorized: true,
  })
  const fp3 = routeFingerprint({
    protocol: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    proxyTls: true,
    proxyTlsRejectUnauthorized: false,
  })

  assert.notEqual(fp1, fp2, 'toggling proxyTls changes fingerprint')
  assert.notEqual(fp2, fp3, 'toggling rejectUnauthorized changes fingerprint')

  const decision = routeStateDecision(
    { fingerprint: fp1, enabled: true, token: 1 },
    { fingerprint: fp2, enabled: true },
  )
  assert.equal(decision.token, 'new')
  assert.equal(decision.clearLastUse, true)
})

test('N22: displayOrigin and endpointSummary display socks5s when proxyTls is true', () => {
  const table = createProxyTable({
    tlsProvider: {
      enabled: true,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      proxyTls: true,
    },
    plainProvider: {
      enabled: true,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      proxyTls: false,
    },
  })

  assert.equal(table.entries.get('tlsProvider')?.proxyOrigin, 'socks5s://127.0.0.1:1080')
  assert.equal(table.entries.get('plainProvider')?.proxyOrigin, 'socks5://127.0.0.1:1080')

  assert.equal(
    endpointSummary({ protocol: 'socks5', host: '127.0.0.1', port: 1080, proxyTls: true }),
    'socks5s://127.0.0.1:1080',
  )
  assert.equal(
    endpointSummary({ protocol: 'socks5', host: '127.0.0.1', port: 1080, proxyTls: false }),
    'socks5://127.0.0.1:1080',
  )
})

test('N22: createProxyTable constructs Socks5ProxyAgent with options.proxyTls', () => {
  const table = createProxyTable({
    p1: {
      enabled: true,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      proxyTls: true,
      proxyTlsRejectUnauthorized: true,
    },
    p2: {
      enabled: true,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      proxyTls: true,
      proxyTlsRejectUnauthorized: false,
    },
    p3: {
      enabled: true,
      protocol: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      proxyTls: false,
    },
  })

  assert.equal(table.problems.size, 0)
  const d1: any = table.entries.get('p1')?.dispatcher
  const d2: any = table.entries.get('p2')?.dispatcher
  const d3: any = table.entries.get('p3')?.dispatcher

  // Socks5ProxyAgent in undici has kProxyProtocol
  // When options.proxyTls is enabled, proxy protocol is 'https:'
  const symbols = Object.getOwnPropertySymbols(d1)
  const protoSym = symbols.find(s => s.description === 'proxy protocol')
  if (protoSym) {
    assert.equal(d1[protoSym], 'https:')
    assert.equal(d2[protoSym], 'https:')
    assert.equal(d3[protoSym], 'http:')
  }
})

test('N22: backup build and parse round-trips proxyTls fields and rejects invalid types', () => {
  const source = {
    providers: {
      p1: {
        enabled: true,
        protocol: 'socks5' as const,
        host: '127.0.0.1',
        port: 1080,
        username: 'alice',
        password: 'secret',
        proxyTls: true,
        proxyTlsRejectUnauthorized: false,
        profileId: '',
        useDefault: false,
        onlyHosts: '',
        bypassHosts: '',
        testTarget: '',
      },
    },
    defaultProxy: {
      protocol: 'socks5' as const,
      host: '127.0.0.1',
      port: 1080,
      username: '',
      password: '',
      proxyTls: true,
      proxyTlsRejectUnauthorized: true,
    },
  }

  const doc = buildBackup(source, { includePasswords: true })
  assert.equal(doc.providers.p1.proxyTls, true)
  assert.equal(doc.providers.p1.proxyTlsRejectUnauthorized, false)
  assert.equal(doc.defaultProxy.proxyTls, true)
  assert.equal(doc.defaultProxy.proxyTlsRejectUnauthorized, true)

  const parsed = parseBackup(JSON.stringify(doc))
  assert.equal(parsed.ok, true)
  if (parsed.ok) {
    assert.equal(parsed.document.providers.p1.proxyTls, true)
    assert.equal(parsed.document.providers.p1.proxyTlsRejectUnauthorized, false)
    assert.equal(parsed.document.defaultProxy.proxyTls, true)
    assert.equal(parsed.document.defaultProxy.proxyTlsRejectUnauthorized, true)
  }

  // Refusal on wrong type
  const bad = {
    providers: {
      p1: {
        proxyTls: 'yes',
      },
    },
  }
  const parsedBad = parseBackup(JSON.stringify(bad))
  assert.equal(parsedBad.ok, false)
  if (!parsedBad.ok) {
    assert.match(parsedBad.error, /proxyTls 必须是布尔值/)
  }
})

test('N22: live TLS SOCKS5 tunnel succeeds with proxyTls: true and proxyTlsRejectUnauthorized: false', async () => {
  // 1. Target HTTP server
  let targetHits = 0
  const targetServer = createServer((req, res) => {
    targetHits++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ target: 'hit', url: req.url }))
  })
  await new Promise<void>(resolve => targetServer.listen(0, '127.0.0.1', resolve))
  const targetPort = (targetServer.address() as net.AddressInfo).port

  // 2. TLS SOCKS5 Proxy server
  let tlsHandshakeDone = false
  let socks5ConnectDone = false

  const proxyServer = tls.createServer(
    {
      key: TEST_KEY,
      cert: TEST_CERT,
    },
    tlsSocket => {
      tlsHandshakeDone = true

      // Handle SOCKS5 protocol over the encrypted TLS stream
      let step = 0
      tlsSocket.on('data', chunk => {
        if (step === 0) {
          // Client greeting: VER (0x05) + NMETHODS
          assert.equal(chunk[0], 0x05)
          // Answer NO_AUTH (0x00)
          tlsSocket.write(Buffer.from([0x05, 0x00]))
          step = 1
        } else if (step === 1) {
          // SOCKS5 request: VER (0x05), CMD CONNECT (0x01), RSV (0x00), ATYP
          assert.equal(chunk[0], 0x05)
          assert.equal(chunk[1], 0x01) // CONNECT
          socks5ConnectDone = true

          // Connect to upstream targetServer
          const upstream = net.connect(targetPort, '127.0.0.1', () => {
            // Success response: VER 5, REP 0, RSV 0, ATYP 1 (IPv4), BND.ADDR 0.0.0.0, BND.PORT 0
            tlsSocket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            tlsSocket.pipe(upstream)
            upstream.pipe(tlsSocket)
          })
          upstream.on('error', () => tlsSocket.destroy())
          step = 2
        }
      })
    },
  )

  await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve))
  const proxyPort = (proxyServer.address() as net.AddressInfo).port

  try {
    const table = createProxyTable({
      sensenova: {
        enabled: true,
        protocol: 'socks5',
        host: '127.0.0.1',
        port: proxyPort,
        proxyTls: true,
        proxyTlsRejectUnauthorized: false,
        localDirect: false,
      },
    })

    const entry = table.entries.get('sensenova')
    assert.ok(entry, 'entry exists')

    // Dispatch request through dispatcher
    const response = await entry.dispatcher.request({
      origin: `http://127.0.0.1:${targetPort}`,
      path: '/test-socks5-tls',
      method: 'GET',
    })

    assert.equal(response.statusCode, 200)
    const body = await response.body.json()
    assert.equal(body.target, 'hit')
    assert.equal(tlsHandshakeDone, true, 'TLS handshake occurred')
    assert.equal(socks5ConnectDone, true, 'SOCKS5 protocol completed over TLS')
    assert.equal(targetHits, 1, 'target server received request')
  } finally {
    await new Promise<void>(resolve => proxyServer.close(() => resolve()))
    await new Promise<void>(resolve => targetServer.close(() => resolve()))
  }
})

test('N22: live TLS SOCKS5 tunnel fails when proxyTlsRejectUnauthorized: true (default strict certificate validation)', async () => {
  const proxyServer = tls.createServer(
    {
      key: TEST_KEY,
      cert: TEST_CERT,
    },
    () => {},
  )

  await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve))
  const proxyPort = (proxyServer.address() as net.AddressInfo).port

  try {
    const table = createProxyTable({
      sensenova: {
        enabled: true,
        protocol: 'socks5',
        host: '127.0.0.1',
        port: proxyPort,
        proxyTls: true,
        proxyTlsRejectUnauthorized: true, // strict validation (default)
        localDirect: false,
      },
    })

    const entry = table.entries.get('sensenova')
    assert.ok(entry, 'entry exists')

    await assert.rejects(
      async () => {
        await entry.dispatcher.request({
          origin: `http://example.com`,
          path: '/',
          method: 'GET',
        })
      },
      (error: any) => {
        // undici should reject due to self-signed certificate in the TLS connection to proxy
        const code = error?.code || error?.cause?.code
        const msg = String(error?.message || error?.cause?.message)
        assert.ok(
          code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
          code === 'CERT_HAS_EXPIRED' ||
          msg.includes('self-signed') ||
          msg.includes('certificate'),
          `expected self-signed cert error, got: ${code} - ${msg}`,
        )
        return true
      },
    )
  } finally {
    await new Promise<void>(resolve => proxyServer.close(() => resolve()))
  }
})


test('N22: preset with proxyTls transfers TLS settings to bound route and creates TLS dispatcher', () => {
  const table = createProxyTable(
    {
      anthropic: {
        enabled: true,
        profileId: 'SecureCluster',
        useDefault: false,
        protocol: 'http',
        host: '',
        port: 0,
      },
    },
    {
      profiles: {
        SecureCluster: {
          protocol: 'socks5',
          host: 'socks-cluster.internal',
          port: 1080,
          proxyTls: true,
          proxyTlsRejectUnauthorized: false,
        },
      },
    },
  )

  const entry = table.entries.get('anthropic')
  assert.ok(entry, 'entry exists for route bound to preset')
  assert.equal(entry.proxyOrigin, 'socks5s://socks-cluster.internal:1080')

  const d: any = entry.dispatcher
  const symbols = Object.getOwnPropertySymbols(d)
  const protoSym = symbols.find(s => s.description === 'proxy protocol')
  if (protoSym) {
    assert.equal(d[protoSym], 'https:')
  }
})
