import { parentPort } from 'node:worker_threads'
import { streamGoWorker } from './go-worker-client.mjs'

// Transport tasks have no DB, scheduler, quota monitor or container lifecycle.
parentPort.on('message', ({ port, options }) => {
  const controller = new AbortController()
  const acks = new Map()
  let lines = []
  let bytes = 0
  let seq = 0
  let first = true
  let immediate = null
  let tail = Promise.resolve()
  const flush = () => {
    if (immediate) clearImmediate(immediate)
    immediate = null
    if (!lines.length) return tail
    const batch = lines
    lines = []
    bytes = 0
    tail = tail.then(() => {
      if (controller.signal.aborted) return
      const id = ++seq
      return new Promise((resolve) => {
        acks.set(id, resolve)
        port.postMessage({ type: 'lines', id, lines: batch })
      })
    })
    return tail
  }
  port.on('message', (message) => {
    if (message.type === 'abort') {
      controller.abort()
      for (const resolve of acks.values()) resolve()
      acks.clear()
    } else if (message.type === 'ack') {
      acks.get(message.id)?.()
      acks.delete(message.id)
    }
  })
  port.on('close', () => {
    controller.abort()
    for (const resolve of acks.values()) resolve()
    acks.clear()
  })
  void (async () => {
    try {
      const result = await streamGoWorker({
        ...options,
        signal: controller.signal,
        onCommit: () => port.postMessage({ type: 'commit' }),
        onEvent: async (line) => {
          await tail
          if (controller.signal.aborted) return
          lines.push(line)
          bytes += Buffer.byteLength(line)
          // First output is immediate; subsequent chunks are bounded and batched
          // per event-loop turn. ACK waits for the downstream callback/drain.
          if (first || bytes >= 16 * 1024 || lines.length >= 64) {
            first = false
            await flush()
          } else if (!immediate) {
            immediate = setImmediate(() => {
              void flush()
            })
          }
        },
      })
      await flush()
      port.postMessage({ type: 'result', result })
    } catch (error) {
      port.postMessage({ type: 'error', error: { message: error.message, code: error.code } })
    } finally {
      if (immediate) clearImmediate(immediate)
      port.close()
    }
  })()
})
setInterval(() => parentPort.postMessage('heartbeat'), 5000).unref()
parentPort.postMessage('ready')
