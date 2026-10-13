import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** Isolated fake upstream; supports Windows named pipes as well as Unix sockets. */
export async function fakeStreamKernel(root, { delayMs = 5, chunks = 8, intervalMs = 5 } = {}) {
  const socketPath =
    process.platform === 'win32' ? `\\\\.\\pipe\\vm2api-test-${randomUUID()}` : path.join(root, 'fake.sock')
  const tokenPath = path.join(root, 'internal.token')
  fs.writeFileSync(tokenPath, 'test-internal-token')
  const stats = { started: 0, active: 0, peak: 0, cancels: [], bodies: [] }
  const active = new Map()
  const sockets = new Set()
  const server = http.createServer(async (req, res) => {
    res.sendDate = false
    let body = ''
    for await (const chunk of req) body += chunk
    if (req.headers['x-kin-internal-token'] !== 'test-internal-token') {
      res.writeHead(401)
      res.end()
      return
    }
    if (req.url === '/internal/health') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true, engine: 'codex', ready: true }))
      return
    }
    const value = JSON.parse(body || '{}')
    if (req.url === '/internal/v1/cancel') {
      stats.cancels.push(value.request_id)
      active.get(value.request_id)?.destroy()
      res.end('{}')
      return
    }
    stats.started++
    stats.active++
    stats.peak = Math.max(stats.peak, stats.active)
    if (stats.bodies.length < 20) stats.bodies.push(value)
    active.set(value.request_id, res)
    res.once('close', () => {
      stats.active--
      active.delete(value.request_id)
    })
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (res.destroyed) return
    res.writeHead(200, { 'content-type': 'text/event-stream', trailer: 'x-usage' })
    const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
    emit({ type: 'response.created', response: { id: 'fake', model: value.body?.model, output: [] } })
    for (let i = 0; i < chunks && !res.destroyed; i++) {
      emit({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: `hello-${i} ` })
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    if (!res.destroyed) {
      const usage = { input_tokens: 20, output_tokens: chunks, input_tokens_details: { cached_tokens: 10 } }
      emit({
        type: 'response.completed',
        response: {
          id: 'fake',
          model: value.body?.model,
          usage,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }],
        },
      })
      res.addTrailers({ 'x-usage': JSON.stringify({ input_tokens: 20, output_tokens: chunks }) })
      res.end()
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return {
    stats,
    socketPath,
    tokenPath,
    exec: {
      vmId: 'vm-fake',
      homeDir: root,
      vm: { runtime: { worker_socket: socketPath, worker_token_file: tokenPath } },
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
