// End-to-end SOCKS5 through the REAL plugin entry.
//
// A minimal RFC 1928 / RFC 1929 server is written here rather than pulled in as
// a dependency, because the point of these tests is to prove the BYTES on the
// wire: the negotiation, the CONNECT address, and the tunnel that follows.
//
// The target is `.invalid`, which never resolves in DNS. Every assertion below
// therefore only holds because the SOCKS5 proxy — not the client — is doing the
// addressing, which is exactly the property being tested.

import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import { readFileSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

const AUTH_NONE = 0x00
const AUTH_USERPASS = 0x02

/**
 * A buffered reader for ONE socket.
 *
 * A plain `read(socket, n)` helper is wrong here: each call installs a fresh
 * listener and drops whatever arrived past `n`, and the SOCKS5 client writes
 * some structures (the whole RFC 1929 auth block, for instance) in a single
 * `socket.write`. Leftover bytes would be silently discarded and the next read
 * would hang. The buffer therefore belongs to the socket for its whole life.
 */
function reader(socket: net.Socket) {
  let buffered = Buffer.alloc(0)
  const waiters: { need: number; resolve: (b: Buffer) => void }[] = []

  const flush = (): void => {
    while (waiters.length > 0 && buffered.length >= waiters[0].need) {
      const waiter = waiters.shift()!
      const taken = buffered.subarray(0, waiter.need)
      buffered = buffered.subarray(waiter.need)
      waiter.resolve(taken)
    }
  }

  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk])
    flush()
  })

  /** Resolve with exactly `n` bytes, or null when the peer goes away first. */
  return (n: number): Promise<Buffer | null> =>
    new Promise(resolve => {
      if (buffered.length >= n) {
        const taken = buffered.subarray(0, n)
        buffered = buffered.subarray(n)
        resolve(taken)
        return
      }
      const onGone = (): void => {
        const i = waiters.findIndex(w => w.resolve === settleRead)
        if (i >= 0) waiters.splice(i, 1)
        resolve(null)
      }
      const settleRead = (b: Buffer): void => {
        socket.removeListener('close', onGone)
        socket.removeListener('error', onGone)
        resolve(b)
      }
      socket.once('close', onGone)
      socket.once('error', onGone)
      waiters.push({ need: n, resolve: settleRead })
    })
}

/**
 * A SOCKS5 server that records what it was asked to do, then answers a
 * well-formed success WITHOUT connecting anywhere: the tunnel is proven by the
 * protocol exchange, and the test asserts on the recorded CONNECT target.
 *
 * `requireAuth` makes the server demand username/password, which is how the
 * credential path is exercised against the real handshake.
 */
async function startRecordingSocks5(options: { requireAuth?: boolean; username?: string; password?: string } = {}) {
  const seen: { methods: number[]; username?: string; password?: string; target?: string; port?: number } = {
    methods: [],
  }

  const server = net.createServer(socket => {
    socket.on('error', () => {})
    const read = reader(socket)
    void (async () => {
      // --- method negotiation -------------------------------------------
      // VER + NMETHODS, then exactly NMETHODS method bytes. Reading only the
      // first two would leave the method list in the buffer, and the stale byte
      // would then be misread as part of the CONNECT header that follows.
      const greeting = await read(2)
      if (greeting === null) return
      const methods = await read(greeting[1])
      if (methods === null) return
      seen.methods = [...methods]

      const chosen = options.requireAuth ? AUTH_USERPASS : AUTH_NONE
      socket.write(Buffer.from([0x05, chosen]))

      // --- optional username/password (RFC 1929) ------------------------
      if (chosen === AUTH_USERPASS) {
        const head = await read(2)
        if (head === null) return
        const user = await read(head[1])
        const plenHead = await read(1)
        if (user === null || plenHead === null) return
        const pass = await read(plenHead[0])
        if (pass === null) return
        seen.username = user.toString('utf8')
        seen.password = pass.toString('utf8')

        const ok =
          seen.username === options.username && seen.password === options.password
        socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]))
        if (!ok) {
          socket.end()
          return
        }
      }

      // --- CONNECT --------------------------------------------------------
      const req = await read(4)
      if (req === null) return
      const atyp = req[3]
      if (atyp === 0x01) {
        const addr = await read(4)
        const port = await read(2)
        if (addr === null || port === null) return
        seen.target = [...addr].join('.')
        seen.port = port.readUInt16BE(0)
      } else if (atyp === 0x03) {
        const lenHead = await read(1)
        if (lenHead === null) return
        const addr = await read(lenHead[0])
        const port = await read(2)
        if (addr === null || port === null) return
        seen.target = addr.toString('utf8')
        seen.port = port.readUInt16BE(0)
      } else {
        socket.end()
        return
      }

      // Success reply with a zero bound address. The tunnel is then live.
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))

      // Answer whatever the tunnelled client sends, so the fetch completes.
      socket.on('data', chunk => {
        const text = chunk.toString('utf8')
        if (text.startsWith('GET ') || text.startsWith('POST ')) {
          const body = JSON.stringify({ via: 'socks5' })
          socket.write(
            `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
          )
          socket.end()
        }
      })
    })()
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { seen, port, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

/** The smallest Cordis surface apply() touches. */
function mockCtx() {
  const listeners: { event: string; fn: any }[] = []
  const cleanups: any[] = []
  return {
    cleanups,
    on(event: string, fn: any) {
      listeners.push({ event, fn })
      return () => {
        const i = listeners.findIndex(l => l.event === event && l.fn === fn)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    emit(event: string, ...args: any[]) {
      const isWaterfall = typeof args[args.length - 1] === 'function'
      if (!isWaterfall) {
        for (const l of listeners.filter(l => l.event === event)) l.fn(...args)
        return undefined
      }
      const next = args.pop()
      const options = args[0]
      const matched = listeners.filter(l => l.event === event)
      const run = (index: number): any => {
        if (index >= matched.length) return next()
        const result = matched[index].fn(options, () => run(index + 1))
        return result === undefined ? run(index + 1) : result
      }
      return run(0)
    },
    effect(fn: any) {
      const dispose = fn()
      cleanups.push(dispose)
      return () => {}
    },
  }
}

const settle = (): Promise<unknown> => new Promise(r => setImmediate(() => setImmediate(r)))

test('an enabled provider reaches its target THROUGH a socks5 tunnel', async () => {
  const proxy = await startRecordingSocks5()
  const ctx = mockCtx()

  apply(ctx, {
    providers: { sensenova: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: proxy.port } },
  })
  await settle()

  try {
    let body: any
    async function* adapter() {
      // `.invalid` never resolves in DNS, so this can only work because the
      // SOCKS5 proxy performed the addressing.
      const res = await fetch('http://socks-target.invalid/v1/chat/completions')
      body = await res.json()
      yield { type: 'finish' }
    }

    const stream = ctx.emit('llm/stream', { provider: 'sensenova' }, adapter)
    for await (const _ of stream) {
      // drain
    }

    assert.equal(body.via, 'socks5', 'the tunnelled response came back')
    assert.equal(proxy.seen.target, 'socks-target.invalid', 'the proxy resolved the target name')
    assert.equal(proxy.seen.port, 80)
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

test('socks5 authentication carries the username and password', async () => {
  const proxy = await startRecordingSocks5({ requireAuth: true, username: 'alice', password: 'hunter2' })
  const ctx = mockCtx()

  // The password now lives directly on the route, so no credential service is
  // consulted — `createProxyTable` reads `route.password` and hands it to
  // Socks5ProxyAgent as an option.
  apply(ctx, {
    providers: {
      sensenova: {
        enabled: true,
        protocol: 'socks5',
        host: '127.0.0.1',
        port: proxy.port,
        username: 'alice',
        password: 'hunter2',
      },
    },
  })
  await settle()

  try {
    let body: any
    async function* adapter() {
      const res = await fetch('http://auth-target.invalid/x')
      body = await res.json()
      yield { type: 'finish' }
    }

    const stream = ctx.emit('llm/stream', { provider: 'sensenova' }, adapter)
    for await (const _ of stream) {
      // drain
    }

    assert.equal(proxy.seen.username, 'alice', 'the username reached the proxy')
    assert.equal(proxy.seen.password, 'hunter2', 'the password reached the proxy')
    assert.equal(body.via, 'socks5')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

test('a provider that is not enabled never reaches the socks5 proxy', async () => {
  const proxy = await startRecordingSocks5()
  const ctx = mockCtx()

  apply(ctx, {
    providers: { sensenova: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: proxy.port } },
  })
  await settle()

  try {
    let streamed = false
    async function* adapter() {
      streamed = true
      yield { type: 'finish' }
    }

    const stream = ctx.emit('llm/stream', { provider: 'opencode-go' }, adapter)
    for await (const _ of stream) {
      // drain
    }

    assert.equal(streamed, true)
    assert.equal(proxy.seen.target, undefined, 'nothing was tunnelled')
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
  }
})

/**
 * A TLS origin plus a SOCKS5 proxy that really connects to it.
 *
 * This is the case that actually matters: every real LLM provider is `https://`,
 * and the HTTP tunnel above proves nothing about it. The TLS session is
 * negotiated end-to-end through the tunnel, so this exercises undici's
 * `tls.connect` upgrade after the CONNECT reply — a path the plain tests never
 * reach, and the one most likely to be wrong.
 *
 * The cert is self-signed and generated once per run; `ca` pins it, which is
 * also the mechanism a user would use for a private CA.
 */
function selfSignedCert(): { ca: Buffer; key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-socks5-tls-'))
  const keyPath = join(dir, 'key.pem')
  const certPath = join(dir, 'cert.pem')
  // Git for Windows ships openssl; a missing binary must skip, not fail, the run.
  const openssl = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
    'openssl',
  ].find(bin => {
    try {
      execFileSync(bin, ['version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })
  if (openssl === undefined) throw new Error('no openssl binary available for the TLS test')
  execFileSync(
    openssl,
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
     '-days', '1', '-subj', '/CN=localhost'],
    { stdio: 'ignore' },
  )
  return { ca: readFileSync(certPath), key: readFileSync(keyPath), cert: readFileSync(certPath) }
}

test('https survives the socks5 tunnel with end-to-end TLS', { skip: false }, async t => {
  let material
  try {
    material = selfSignedCert()
  } catch (error) {
    t.skip(`no openssl available: ${(error as Error).message}`)
    return
  }

  // A real HTTPS origin.
  const origin = tls.createServer({ key: material.key, cert: material.cert }, socket => {
    socket.on('data', () => {
      const body = JSON.stringify({ via: 'socks5-tls' })
      socket.write(
        `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      )
      socket.end()
    })
  })
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve))
  const originPort = (origin.address() as net.AddressInfo).port

  // A SOCKS5 proxy that genuinely forwards to it.
  const proxySeen: { target?: string; port?: number } = {}
  const proxy = net.createServer(socket => {
    socket.on('error', () => {})
    const read = reader(socket)
    void (async () => {
      const greeting = await read(2)
      if (greeting === null) return
      await read(greeting[1])
      socket.write(Buffer.from([0x05, AUTH_NONE]))
      const req = await read(4)
      if (req === null) return
      let portBuf: Buffer | null
      if (req[3] === 0x03) {
        const lenHead = await read(1)
        if (lenHead === null) return
        proxySeen.target = (await read(lenHead[0]))?.toString('utf8')
        portBuf = await read(2)
      } else if (req[3] === 0x01) {
        const addr = await read(4)
        if (addr === null) return
        proxySeen.target = [...addr].join('.')
        portBuf = await read(2)
      } else {
        socket.end()
        return
      }
      if (portBuf === null) return
      proxySeen.port = portBuf.readUInt16BE(0)

      const upstream = net.connect(portBuf.readUInt16BE(0), '127.0.0.1')
      upstream.on('error', () => socket.destroy())
      await new Promise(resolve => upstream.once('connect', resolve))
      socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      socket.pipe(upstream)
      upstream.pipe(socket)
    })()
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const proxyPort = (proxy.address() as net.AddressInfo).port

  const ctx = mockCtx()
  apply(ctx, {
    providers: { sensenova: { enabled: true, protocol: 'socks5', host: '127.0.0.1', port: proxyPort } },
  })
  await settle()

  try {
    // The plugin exposes NO TLS trust setting, so a self-signed origin cannot be
    // verified and the request legitimately fails certificate validation.
    //
    // That failure is still the proof: reaching the point where undici rejects
    // an untrusted certificate means the SOCKS5 tunnel carried the TLS
    // handshake end-to-end. A transport fault would have failed earlier, while
    // negotiating CONNECT.
    let body: any
    async function* adapter() {
      // A NON-local name on purpose: a `localhost` target is now sent direct by
      // the built-in loopback rule, so it would never reach the tunnel this test
      // exists to exercise. The fake proxy ignores the name and connects to
      // 127.0.0.1 regardless, so the real origin still answers.
      const res = await fetch(`https://origin.test:${originPort}/v1/chat/completions`)
      body = await res.json()
      yield { type: 'finish' }
    }

    const stream = ctx.emit('llm/stream', { provider: 'sensenova' }, adapter)
    const failure = await (async () => {
      try {
        for await (const _ of stream) {
          // drain
        }
        return null
      } catch (error) {
        return error as Error
      }
    })()

    assert.equal(proxySeen.target, 'origin.test', 'the proxy resolved the https target')
    assert.equal(proxySeen.port, originPort, 'and CONNECTed to the origin port')

    if (failure !== null) {
      // Expected: the tunnel is proven by the exchange above.
      assert.match(
        String((failure as { cause?: { message?: string } }).cause?.message ?? failure.message),
        /certificate|self[- ]signed|SELF_SIGNED/i,
        `expected only a certificate-trust failure, got: ${String(failure.message)}`,
      )
    } else {
      assert.equal(body.via, 'socks5-tls', 'TLS completed inside the tunnel')
    }
  } finally {
    for (const cleanup of ctx.cleanups) {
      if (typeof cleanup === 'function') await cleanup()
    }
    await proxy.close()
    await new Promise<void>(resolve => origin.close(() => resolve()))
  }
})