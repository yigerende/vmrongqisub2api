import { Worker, MessageChannel, isMainThread } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { availableParallelism } from 'node:os'

// kernel-router also carries owner-only hooks (credential refresh, lifecycle,
// scheduling). The synchronous client ignores them; never clone them to a worker.
const TRANSPORT_FIELDS = [
  'requestContext',
  'exec',
  'body',
  'reqHeaders',
  'timeoutMs',
  'idleTimeoutMs',
  'identity',
  'deliveryMode',
  'want1m',
  'cacheTtl',
  'preserveCacheBreakpoints',
  'requestPath',
  'envelope',
  'cliHop',
]

/** Stateless transport only. The caller continues to own every scheduling lease. */
export class StreamWorkers {
  constructor({ size = Math.min(8, Math.max(1, availableParallelism() - 2)), cancel = async () => {} } = {}) {
    if (!Number.isInteger(size) || size < 1 || size > 64) throw new Error('stream workers must be 1..64')
    this.size = size
    this.cancel = cancel
    this.workers = []
    this.closed = false
    this.restarts = 0
  }

  spawn() {
    const worker = new Worker(new URL('./stream-worker.mjs', import.meta.url))
    const entry = { worker, tasks: new Set(), dead: false, heartbeat: Date.now() }
    const fail = (error) => {
      if (entry.dead) return entry.failure
      entry.dead = true
      clearInterval(entry.watchdog)
      this.workers = this.workers.filter((item) => item !== entry)
      this.restarts++
      // Do not replay a worker's job: the upstream might already have accepted
      // it. Cancel each exact kernel request before the owner releases its lease.
      entry.failure = Promise.all(
        [...entry.tasks].map(async (task) => {
          try {
            await this.cancel(task.exec, task.requestId)
          } catch {}
          task.fail(error)
        }),
      )
      return entry.failure
    }
    worker.on('error', (error) => {
      void fail(error)
    })
    worker.on('exit', () => {
      void fail(Object.assign(new Error('stream worker exited'), { code: 'stream_worker_exited' }))
    })
    worker.on('message', (message) => {
      if (message === 'heartbeat' || message === 'ready') entry.heartbeat = Date.now()
      if (message === 'ready') {
        entry.readyResolve()
        if (!entry.tasks.size) worker.unref()
      }
    })
    entry.ready = new Promise((resolve, reject) => {
      entry.readyResolve = resolve
      worker.once('error', reject)
      worker.once('exit', () => reject(new Error('stream worker exited before ready')))
    })
    entry.ready.catch(() => {})
    entry.watchdog = setInterval(() => {
      if (entry.tasks.size && Date.now() - entry.heartbeat > 60_000) void worker.terminate()
    }, 10_000)
    entry.watchdog.unref()
    // Keep startup alive until ready, even before the HTTP listener exists.
    this.workers.push(entry)
    return entry
  }

  async start() {
    if (this.closed) throw new Error('stream workers are closed')
    while (this.workers.length < this.size) this.spawn()
    await Promise.all(this.workers.map((entry) => entry.ready))
  }

  async run(options) {
    await this.start()
    const entry = this.workers.reduce((a, b) => (a.tasks.size <= b.tasks.size ? a : b))
    const { onEvent, onCommit, signal } = options
    const payload = Object.fromEntries(TRANSPORT_FIELDS.map((key) => [key, options[key]]))
    const requestId = randomUUID()
    const { port1, port2 } = new MessageChannel()
    return new Promise((resolve, reject) => {
      let settled = false
      let abortTimer = null
      let events = Promise.resolve()
      const cleanup = () => {
        settled = true
        clearTimeout(abortTimer)
        signal?.removeEventListener('abort', abort)
        port1.close()
        entry.tasks.delete(task)
        if (!entry.tasks.size) entry.worker.unref()
      }
      const task = {
        exec: options.exec,
        requestId,
        fail(error) {
          if (settled) return
          cleanup()
          reject(error)
        },
        abort: () => abort(),
      }
      const abort = () => {
        if (settled || abortTimer) return
        port1.postMessage({ type: 'abort' })
        // Also works when a stream thread is stuck in CPU work and cannot read
        // its abort message. Cancellation is idempotent in the slot kernel.
        void this.cancel(task.exec, requestId).catch(() => {})
        abortTimer = setTimeout(() => {
          void entry.worker.terminate()
        }, 5000)
        abortTimer.unref()
      }
      entry.tasks.add(task)
      entry.worker.ref()
      port1.on('message', (message) => {
        events = events
          .then(async () => {
            if (settled) return
            if (message.type === 'commit') {
              await onCommit?.()
            } else if (message.type === 'lines') {
              for (const line of message.lines) await onEvent?.(line)
              if (!settled) port1.postMessage({ type: 'ack', id: message.id })
            } else if (message.type === 'result') {
              cleanup()
              resolve(message.result)
            } else if (message.type === 'error') {
              task.fail(Object.assign(new Error(message.error.message), { code: message.error.code }))
            }
          })
          .catch(async (error) => {
            abort()
            try {
              await this.cancel(task.exec, requestId)
            } catch {}
            task.fail(error)
          })
      })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        entry.worker.postMessage({ port: port2, options: { ...payload, requestId } }, [port2])
        if (signal?.aborted) abort()
      } catch (error) {
        port2.close()
        task.fail(error)
      }
    })
  }

  snapshot() {
    return {
      workers: this.workers.length,
      active: this.workers.reduce((n, e) => n + e.tasks.size, 0),
      restarts: this.restarts,
    }
  }

  abortAll() {
    for (const entry of this.workers) for (const task of entry.tasks) task.abort()
  }

  async close() {
    this.closed = true
    this.abortAll()
    const entries = [...this.workers]
    await Promise.all(
      entries.map(async (entry) => {
        await entry.worker.terminate()
        await entry.failure
      }),
    )
  }
}

let pool = null

export async function startStreamWorkers({ size, cancel } = {}) {
  if (!isMainThread || size === 0) return
  pool = new StreamWorkers({ size, cancel })
  await pool.start()
}

export const streamWorkerPool = () => pool
