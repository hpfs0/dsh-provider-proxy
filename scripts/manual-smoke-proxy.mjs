import { appendFileSync } from 'node:fs'
import net from 'node:net'
import { createServer } from 'node:http'

const port = Number(process.env.SMOKE_PROXY_PORT ?? 17891)
const log = process.env.SMOKE_PROXY_LOG ?? 'manual-smoke-proxy.log'
const slowMs = Number(process.env.SMOKE_PROXY_SLOW_MS ?? 6000)

const server = createServer((req, res) => {
  const entry = { at: Date.now(), method: req.method, host: req.headers.host, url: req.url }
  appendFileSync(log, `${JSON.stringify(entry)}\n`)
  const reply = () => {
    if (String(req.url).includes('google.com')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><title>proxy smoke ok</title>ok')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, via: 'manual-smoke-proxy' }))
  }
  if (String(req.url).includes('/slow')) setTimeout(reply, slowMs)
  else reply()
})

// A real CONNECT tunnel: forward the target host:port over TCP so the proxied
// request can actually succeed and record a "last ok".
server.on('connect', (req, client, head) => {
  appendFileSync(log, `${JSON.stringify({ at: Date.now(), tunnel: req.url })}\n`)
  const [host, portText] = String(req.url).split(':')
  const upstream = net.connect(Number(portText) || 443, host, () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
  })
  upstream.on('error', () => {
    client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    client.end()
  })
  client.on('error', () => upstream.destroy())
  upstream.on('close', () => client.destroy())
  client.on('close', () => upstream.destroy())
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`manual-smoke-proxy listening on 127.0.0.1:${port}\n`)
})
