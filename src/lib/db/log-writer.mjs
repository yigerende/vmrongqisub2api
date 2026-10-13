import { Worker } from 'node:worker_threads'

/** Bounded, replayable batches. Billing decisions stay in the owner process. */
export class LogWriter {
  constructor(
    dbPath,
    persist,
    {
      maxRows = 1024,
      maxBytes = 16 * 1024 * 1024,
      timeoutMs = 15_000,
      createWorker = () => new Worker(new URL('./log-writer-worker.mjs', import.meta.url), { workerData: { dbPath } }),
    } = {},
  ) {
    this.dbPath = dbPath
    this.persist = persist
    this.maxRows = maxRows
    this.maxBytes = maxBytes
    this.timeoutMs = timeoutMs
    this.createWorker = createWorker
    this.queue = []
    this.batch = null
    this.bytes = 0
    this.waiters = []
    this.sequence = 0
    this.enqueued = 0
    this.persisted = 0
    this.fallbacks = 0
    this.closed = false
    this.scheduled = false
    this.spawn()
  }

  spawn() {
    let worker
    try {
      worker = this.createWorker()
    } catch (error) {
      this.failed(error)
      return
    }
    this.worker = worker
    this.ready = false
    let failed = false
    const fail = (error) => {
      if (failed || this.worker !== worker) return
      failed = true
      this.failed(error)
    }
    let workerError
    worker.on('error', (error) => {
      workerError = error
    })
    worker.on('exit', (code) => {
      if (!this.closed) fail(workerError || new Error(`writer exited (${code})`))
    })
    worker.on('message', (message) => {
      if (this.worker !== worker) return
      if (message.type === 'ready') {
        clearTimeout(this.timer)
        this.ready = true
        this.pump()
        return
      }
      if (!this.batch || message.id !== this.batch.id) return
      clearTimeout(this.timer)
      if (message.error) {
        // This batch rolled back; no later batch has been sent to the worker.
        void worker.terminate()
        fail(Object.assign(new Error(message.error.message), { code: message.error.code }))
        return
      } else if (!this.batch.retired) this.bytes -= this.batch.bytes
      this.persisted = Math.max(this.persisted, this.batch.entries.at(-1).sequence)
      this.batch = null
      this.pump()
      this.settled()
    })
    this.armTimeout(worker)
    worker.unref()
  }

  armTimeout(worker) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void worker.terminate()
    }, this.timeoutMs)
    this.timer.unref()
  }

  failed(error) {
    clearTimeout(this.timer)
    this.worker = null
    this.ready = false
    // A worker can die after COMMIT but before ACK. Retain and replay the same
    // immutable summary ids in order; INSERT OR IGNORE prevents double counting.
    if (this.batch && !this.batch.retired) {
      this.queue.unshift(...this.batch.entries)
    }
    this.batch = null
    try {
      this.fallback()
    } catch (writeError) {
      // Keep the bounded queue intact so a later flush can retry after recovery.
      this.error = writeError
      this.rejectWaiters(writeError)
    }
    this.settled()
    console.warn('[request-log] background writer failed:', error?.code || error?.message)
  }

  enqueue(record) {
    if (this.closed || this.closing) throw new Error('log writer is closed')
    if (this.error) this.fallback()
    record = { summary: { ...record.summary } }
    const bytes = Buffer.byteLength(JSON.stringify(record))
    const count = this.queue.length + (this.batch?.retired ? 0 : this.batch?.rows.length || 0)
    if (count >= this.maxRows || this.bytes + bytes > this.maxBytes) this.fallback()
    // An individual summary can exceed the queue byte budget. Persist it
    // directly, after older rows, rather than dropping it or buffering unboundedly.
    if (bytes > this.maxBytes) {
      this.persist([record])
      return
    }
    this.queue.push({ record, bytes, sequence: ++this.enqueued })
    this.bytes += bytes
    if (!this.worker) this.spawn()
    this.worker?.ref()
    if (!this.scheduled) {
      this.scheduled = true
      setImmediate(() => {
        this.scheduled = false
        this.pump()
      })
    }
  }

  pump() {
    if (!this.ready || !this.worker || this.batch || !this.queue.length) return
    const entries = this.queue.splice(0, 32)
    this.batch = {
      id: ++this.sequence,
      entries,
      rows: entries.map((entry) => entry.record),
      bytes: entries.reduce((n, entry) => n + entry.bytes, 0),
    }
    this.worker.ref()
    this.armTimeout(this.worker)
    try {
      this.worker.postMessage({ id: this.batch.id, rows: this.batch.rows })
    } catch (error) {
      void this.worker.terminate()
      this.failed(error)
    }
  }

  fallback() {
    const rows = [
      ...(this.batch && !this.batch.retired ? this.batch.rows : []),
      ...this.queue.map((entry) => entry.record),
    ]
    if (rows.length) this.persist(rows)
    this.persisted = this.enqueued
    this.queue = []
    this.bytes = 0
    this.error = null
    if (this.batch) this.batch.retired = true
    this.fallbacks++
    this.settled()
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  settled() {
    if (!this.batch && !this.queue.length) this.worker?.unref()
    this.waiters = this.waiters.filter((waiter) => {
      if (waiter.sequence > this.persisted) return true
      waiter.resolve()
      return false
    })
  }

  flush() {
    if (this.error) {
      try {
        this.fallback()
        this.settled()
      } catch (error) {
        return Promise.reject(error)
      }
    }
    // Wait only for rows already accepted at the time of the read. Continuous
    // traffic must not starve reporting by keeping the queue nonempty forever.
    if (this.persisted >= this.enqueued) return Promise.resolve()
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject, sequence: this.enqueued })
      this.pump()
      this.settled()
    })
  }

  async close() {
    this.closing = true
    try {
      await this.flush()
    } finally {
      this.closed = true
      clearTimeout(this.timer)
      await this.worker?.terminate()
      this.worker = null
    }
  }
}
