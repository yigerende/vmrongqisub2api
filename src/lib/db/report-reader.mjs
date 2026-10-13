import { Worker } from 'node:worker_threads'

/** Reporting connections (plus the existing legacy-cost backfill), outside the gateway loop. */
export class ReportReader {
  constructor(dbPath, { workers = 2, maxPending = 64, timeoutMs = 30_000 } = {}) {
    this.dbPath = dbPath
    this.size = workers
    this.maxPending = maxPending
    this.timeoutMs = timeoutMs
    this.workers = []
    this.pending = new Map()
    this.sequence = 0
    this.closed = false
  }

  spawn() {
    const worker = new Worker(new URL('./report-worker.mjs', import.meta.url), {
      workerData: { dbPath: this.dbPath },
    })
    const entry = { worker, pending: 0 }
    const fail = (error) => {
      this.workers = this.workers.filter((item) => item !== entry)
      for (const [id, task] of this.pending) {
        if (task.entry !== entry) continue
        clearTimeout(task.timer)
        this.pending.delete(id)
        task.reject(error)
      }
    }
    worker.on('error', fail)
    worker.on('exit', () => fail(Object.assign(new Error('report worker exited'), { status: 503 })))
    worker.on('message', ({ id, value, error }) => {
      const task = this.pending.get(id)
      if (!task || task.entry !== entry) return
      clearTimeout(task.timer)
      this.pending.delete(id)
      entry.pending--
      if (!entry.pending) worker.unref()
      if (error) task.reject(Object.assign(new Error(error.message), { code: error.code, status: 503 }))
      else task.resolve(value)
    })
    worker.unref()
    this.workers.push(entry)
    return entry
  }

  call(kind, method, args = [], options = {}) {
    if (this.closed || this.pending.size >= this.maxPending) {
      return Promise.reject(Object.assign(new Error('reporting is busy; retry shortly'), { status: 503 }))
    }
    while (this.workers.length < this.size) this.spawn()
    const entry = this.workers.reduce((a, b) => (a.pending <= b.pending ? a : b))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A blocked SQLite call cannot process a cancel message. Reap that reader;
        // it owns no scheduling state, credentials or upstream requests. SQLite
        // rolls back an interrupted legacy-cost backfill transaction on close.
        void entry.worker.terminate()
      }, this.timeoutMs)
      timer.unref()
      this.pending.set(id, { entry, resolve, reject, timer })
      entry.pending++
      entry.worker.ref()
      try {
        entry.worker.postMessage({ id, kind, method, args, options })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        entry.pending--
        if (!entry.pending) entry.worker.unref()
        reject(error)
      }
    })
  }

  async close() {
    this.closed = true
    await Promise.all(this.workers.map(({ worker }) => worker.terminate()))
    this.workers = []
  }
}

// Mocks and embedded users retain their synchronous stores. HTTP handlers await
// either form, so there is a single implementation of every reporting rule.
export function readLog(store, method, ...args) {
  if (store?.read) return store.read(method, ...args)
  return store?.[method]?.(...args)
}
