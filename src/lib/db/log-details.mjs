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
      if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) bytes += item.byteLength + 64
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
      maxBytes = 512 * 1024 * 1024,
      maxRecordBytes = 16 * 1024 * 1024,
      timeoutMs = 30000,
      retryMs = 250,
      createWorker = () =>
        new Worker(new URL('./log-details-worker.mjs', import.meta.url), { workerData: { dbPath, root } }),
    } = {},
  ) {
    Object.assign(this, { dbPath, root, maxRows, maxBytes, maxRecordBytes, timeoutMs, retryMs, createWorker })
    this.queue = []
    this.batches = []
    this.bytes = 0
    this.peakBytes = 0
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
          clearTimeout(this.maintenanceTimer)
          const pending = this.maintenance
          this.maintenance = null
          if (message.error) pending?.reject(new Error(message.error))
          else pending?.resolve(message.result)
          this.settled()
        } else if (this.batches.length && message.id === this.batches[0].sequence) {
          if (message.error) {
            workerError = new Error(message.error)
            void worker.terminate() // Wait for exit before replay; no two writers race.
            return
          }
          clearTimeout(this.timer)
          const batch = this.batches.shift()
          this.persisted = batch.sequence
          if (message.omitted) {
            this.dropped += message.omitted
            this.warn('debug/JSONL record omitted (usage summary retained)', 'payload could not be serialized')
          }
          this.bytes -= batch.bytes
          this.workerMetrics = message.metrics || this.workerMetrics
          this.error = null
          this.pump()
          if (this.batches.length) this.armTimeout()
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
    clearTimeout(this.maintenanceTimer)
    this.error = error
    this.failures++
    this.queue.unshift(...this.batches.flatMap((batch) => batch.entries))
    this.batches = []
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
      if (this.queue.length + this.batches.reduce((n, batch) => n + batch.entries.length, 0) >= this.maxRows)
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
    this.peakBytes = Math.max(this.peakBytes, this.bytes)
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
    const inFlight = this.batches.length
    if (this.maintenance && !this.maintenance.sent) {
      this.maintenance.sent = true
      this.worker.ref()
      this.maintenanceTimer = setTimeout(() => {
        void this.worker?.terminate()
      }, 120000)
      this.maintenanceTimer.unref()
      this.worker.postMessage({ type: 'cleanup', options: this.maintenance.options })
    }
    // A small window keeps the worker fed while the owner is busy forwarding
    // frames. Retain every unacknowledged batch, in order, for crash replay.
    while (this.batches.length < 4 && this.queue.length) {
      const entries = []
      let bytes = 0
      while (this.queue.length && entries.length < 8) {
        const next = this.queue[0]
        if (entries.length && bytes + next.bytes > 4 * 1024 * 1024) break
        entries.push(this.queue.shift())
        bytes += next.bytes
      }
      const batch = { entries, bytes, sequence: entries.at(-1).sequence }
      this.batches.push(batch)
      this.worker.ref()
      this.worker.postMessage({ id: batch.sequence, jobs: entries.map((entry) => entry.job) })
    }
    if (!inFlight && this.batches.length) this.armTimeout()
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
    if (!this.batches.length && !this.queue.length && !this.maintenance) this.worker?.unref()
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
      queued_records: this.queue.length + this.batches.reduce((n, batch) => n + batch.entries.length, 0),
      queued_bytes: this.bytes,
      peak_queued_bytes: this.peakBytes,
      max_queue_bytes: this.maxBytes,
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
      clearTimeout(this.maintenanceTimer)
      await this.worker?.terminate()
      this.worker = null
    }
  }
}

/** Hash by request id: repeated debug records always share one ordered writer. */
export class LogDetailsPool {
  constructor(dbPath, options = {}) {
    this.writers = Array.from({ length: 2 }, () => new LogDetails(dbPath, { ...options, maxBytes: 256 * 1024 * 1024 }))
  }

  enqueue(job) {
    const id = String(job.summary.request_id || job.summary.id || '')
    let hash = 2166136261
    for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619)
    return this.writers[(hash >>> 0) % this.writers.length].enqueue(job)
  }

  flush() {
    return Promise.all(this.writers.map((writer) => writer.flush()))
  }

  cleanup(options) {
    return this.writers[0].cleanup(options)
  }

  async close() {
    const results = await Promise.allSettled(this.writers.map((writer) => writer.close()))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }

  snapshot() {
    const workers = this.writers.map((writer) => writer.snapshot())
    const counters = [
      'queued_records',
      'queued_bytes',
      'peak_queued_bytes',
      'max_queue_bytes',
      'dropped_records',
      'failures',
      'restarts',
      'persisted_records',
    ]
    return {
      ...Object.fromEntries(counters.map((key) => [key, workers.reduce((n, worker) => n + worker[key], 0)])),
      cleanup_running: workers.some((worker) => worker.cleanup_running),
      workers,
    }
  }
}
