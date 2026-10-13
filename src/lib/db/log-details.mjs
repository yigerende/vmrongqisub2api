import { Worker } from 'node:worker_threads'

// Count bytes conservatively without serializing bodies on the event loop.
// The walk itself is bounded, including adversarial wide/deep JSON objects.
export function detailBytes(value, limit) {
  const seen = new WeakSet()
  let bytes = 0
  let nodes = 0
  const visit = (item, depth = 0) => {
    if (++nodes > 50000 || depth > 64 || bytes > limit) throw new RangeError('debug payload too large')
    if (typeof item === 'string') bytes += item.length * 2 + 16
    else if (item && typeof item === 'object') {
      if (seen.has(item)) return
      seen.add(item)
      if (ArrayBuffer.isView(item)) bytes += item.byteLength + 64
      else {
        bytes += 64
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue
          bytes += key.length * 2 + 16
          visit(item[key], depth + 1)
        }
      }
    } else bytes += 16
    if (bytes > limit) throw new RangeError('debug payload too large')
  }
  visit(value)
  return bytes
}

/** Best-effort debug/JSONL + retention. Never run large work on the owner. */
export class LogDetails {
  constructor(
    dbPath,
    {
      root,
      maxRows = 1024,
      maxBytes = 128 * 1024 * 1024,
      maxRecordBytes = 16 * 1024 * 1024,
      timeoutMs = 30000,
      retryMs = 250,
      createWorker = () =>
        new Worker(new URL('./log-details-worker.mjs', import.meta.url), { workerData: { dbPath, root } }),
    } = {},
  ) {
    Object.assign(this, { dbPath, root, maxRows, maxBytes, maxRecordBytes, timeoutMs, retryMs, createWorker })
    this.queue = []
    this.bytes = 0
    this.enqueued = 0
    this.persisted = 0
    this.waiters = []
    this.dropped = 0
    this.restarts = 0
    this.failures = 0
    this.spawn()
  }

  spawn() {
    if (this.closed || this.worker) return
    try {
      const worker = this.createWorker()
      this.worker = worker
      let workerError
      worker.on('error', (error) => {
        workerError = error
      })
      worker.on('exit', (code) => {
        if (this.worker !== worker) return
        this.worker = null
        this.ready = false
        clearTimeout(this.timer)
        if (!this.closed) this.failed(workerError || new Error(`detail writer exited (${code})`))
      })
      worker.on('message', (message) => {
        if (this.worker !== worker || this.closed) return
        if (message.type === 'ready') {
          clearTimeout(this.timer)
          this.ready = true
          this.pump()
        } else if (message.type === 'cleanup') {
          const pending = this.maintenance
          this.maintenance = null
          if (message.error) pending?.reject(new Error(message.error))
          else pending?.resolve(message.result)
          this.settled()
        } else if (this.batch && message.id === this.batch.sequence) {
          if (message.error) {
            workerError = new Error(message.error)
            void worker.terminate() // Wait for exit before replay; no two writers race.
            return
          }
          clearTimeout(this.timer)
          this.persisted = this.batch.sequence
          if (message.omitted) {
            this.dropped += message.omitted
            this.warn('debug/JSONL record omitted (usage summary retained)', 'payload could not be serialized')
          }
          this.bytes -= this.batch.bytes
          this.workerMetrics = message.metrics || this.workerMetrics
          this.batch = null
          this.error = null
          this.pump()
        }
        this.settled()
      })
      this.armTimeout()
      worker.unref()
    } catch (error) {
      this.failed(error)
    }
  }

  armTimeout() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.worker?.terminate()
    }, this.timeoutMs)
    this.timer.unref()
  }

  failed(error) {
    clearTimeout(this.timer)
    this.error = error
    this.failures++
    if (this.batch) this.queue.unshift(...this.batch.entries)
    this.batch = null
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
    this.maintenance?.reject(error)
    this.maintenance = null
    this.warn('background detail writer failed', error.message)
    if (!this.closed) {
      this.retryTimer = setTimeout(
        () => {
          this.restarts++
          this.spawn()
        },
        Math.min(5000, this.retryMs * Math.max(1, this.failures)),
      )
      this.retryTimer.unref()
    }
  }

  warn(message, reason) {
    if (this.lastWarning && Date.now() - this.lastWarning < 60000) return
    this.lastWarning = Date.now()
    console.warn(`[request-log] ${message}: ${reason}`)
  }

  enqueue(job) {
    if (this.closed || this.closing) return false
    let bytes
    try {
      if (this.queue.length + (this.batch?.entries.length || 0) >= this.maxRows)
        throw new RangeError('debug queue full')
      bytes = detailBytes(job, Math.min(this.maxRecordBytes, this.maxBytes - this.bytes))
      // Snapshot before finish() returns: later mutation cannot change this record.
      job = structuredClone(job)
    } catch (error) {
      this.dropped++
      this.warn('debug/JSONL record omitted (usage summary retained)', error.message)
      return false
    }
    this.queue.push({ job, bytes, sequence: ++this.enqueued })
    this.bytes += bytes
    this.worker?.ref()
    if (!this.scheduled) {
      this.scheduled = true
      setImmediate(() => {
        this.scheduled = false
        this.pump()
      })
    }
    return true
  }

  pump() {
    if (!this.ready || !this.worker) return
    if (this.maintenance && !this.maintenance.sent) {
      this.maintenance.sent = true
      this.worker.ref()
      this.worker.postMessage({ type: 'cleanup', options: this.maintenance.options })
    }
    if (this.batch || !this.queue.length) return
    const entries = []
    let bytes = 0
    // Amortize IPC, keep each batch small enough that raw payload cloning and
    // the SQLite write transaction cannot monopolize another request's turn.
    while (this.queue.length && entries.length < 8) {
      const next = this.queue[0]
      if (entries.length && bytes + next.bytes > 2 * 1024 * 1024) break
      entries.push(this.queue.shift())
      bytes += next.bytes
    }
    this.batch = { entries, bytes, sequence: entries.at(-1).sequence }
    this.worker.ref()
    this.armTimeout()
    this.worker.postMessage({ id: this.batch.sequence, jobs: entries.map((entry) => entry.job) })
  }

  cleanup(options) {
    if (this.closed || this.closing) return Promise.resolve(null)
    if (this.maintenance) return this.maintenance.promise
    let resolve, reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    this.maintenance = { options, promise, resolve, reject, sent: false }
    this.worker?.ref()
    this.pump()
    return promise
  }

  settled() {
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.sequence > this.persisted) return true
      waiter.resolve()
      return false
    })
    if (!this.batch && !this.queue.length && !this.maintenance) this.worker?.unref()
  }

  flush() {
    if (this.persisted >= this.enqueued) return Promise.resolve()
    if (this.error) return Promise.reject(this.error)
    return new Promise((resolve, reject) => {
      this.waiters.push({ sequence: this.enqueued, resolve, reject })
      this.worker?.ref()
      this.pump()
    })
  }

  snapshot() {
    return {
      queued_records: this.queue.length + (this.batch?.entries.length || 0),
      queued_bytes: this.bytes,
      dropped_records: this.dropped,
      failures: this.failures,
      restarts: this.restarts,
      persisted_records: this.persisted,
      cleanup_running: !!this.maintenance,
      worker: this.workerMetrics || null,
    }
  }

  async close() {
    this.closing = true
    try {
      await Promise.all([this.flush(), this.maintenance?.promise])
    } finally {
      this.closed = true
      clearTimeout(this.timer)
      clearTimeout(this.retryTimer)
      await this.worker?.terminate()
      this.worker = null
    }
  }
}
