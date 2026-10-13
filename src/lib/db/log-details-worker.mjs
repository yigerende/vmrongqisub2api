import fs from 'node:fs'
import path from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { UsageLogsRepo } from './repos/usage-logs-repo.mjs'
import { buildDebugRecord } from '../admin/debug-record.mjs'
import { encodeDebugJson } from './debug-codec.mjs'

const db = new DatabaseSync(workerData.dbPath)
db.exec(
  'PRAGMA busy_timeout = 1000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA wal_autocheckpoint = 0',
)
const repo = new UsageLogsRepo(db)
let lastCheckpoint = 0
let writtenBytes = 0
let maintenance = false
const metrics = { prepare_ms: 0, write_ms: 0, checkpoint_ms: 0, cleanup_ms: 0 }
function checkpoint(force = false) {
  if (!force && writtenBytes < 8 * 1024 * 1024 && Date.now() - lastCheckpoint < 5000) return
  // PASSIVE never waits for readers/writers. Busy readers leave WAL pages for
  // the next pass; no TRUNCATE checkpoint on the gateway's event loop.
  const start = performance.now()
  db.exec('PRAGMA wal_checkpoint(PASSIVE)')
  metrics.checkpoint_ms += performance.now() - start
  writtenBytes = 0
  lastCheckpoint = Date.now()
}
setInterval(() => {
  try {
    checkpoint()
  } catch {}
}, 5000).unref()

function cleanupFiles(days, dir) {
  const cutoff = Date.now() - days * 86400_000
  if (!dir || !fs.existsSync(dir)) return
  for (const name of fs.readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(name)) continue
    const dayMs = Date.parse(name.slice(0, 10) + 'T00:00:00Z')
    if (Number.isFinite(dayMs) && dayMs < cutoff) fs.rmSync(path.join(dir, name), { recursive: true, force: true })
  }
}

parentPort.on('message', async ({ id, jobs, type, options }) => {
  if (type === 'cleanup') {
    if (maintenance) return
    maintenance = true
    try {
      const state = repo.beginCleanup(options)
      // Capture a horizon once. New writes may proceed between short delete
      // steps, and cleanup cannot starve debug ingestion indefinitely.
      for (;;) {
        const start = performance.now()
        const done = repo.cleanupStep(state)
        metrics.cleanup_ms += performance.now() - start
        if (done) break
        await delay(2)
      }
      cleanupFiles(options.retainDays, workerData.root)
      if (workerData.root) cleanupFiles(options.debugRetainDays, path.join(workerData.root, 'debug'))
      checkpoint(true)
      parentPort.postMessage({ type, result: state.result })
    } catch (error) {
      parentPort.postMessage({ type, error: error.message })
    } finally {
      maintenance = false
    }
    return
  }
  try {
    const start = performance.now()
    // Prepare every JSON before acquiring the write lock. Small transactions
    // reduce fsync/IPC overhead without contending with scheduling for long.
    const records = []
    let omitted = 0
    for (const job of jobs) {
      try {
        records.push({
          ...job,
          json: job.debug ? encodeDebugJson(JSON.stringify(buildDebugRecord(job.summary, job.debug))) : null,
        })
      } catch {
        // A non-JSON payload cannot poison the queue forever. Summary accounting
        // is independent; report the omitted diagnostic record to the owner.
        omitted++
      }
    }
    metrics.prepare_ms += performance.now() - start
    const writeAt = performance.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const job of records)
        if (job.json) {
          repo.insertDebugJson(job.summary.request_id || job.summary.id, job.summary.ts, job.json)
          writtenBytes += Buffer.byteLength(job.json)
        }
      db.exec('COMMIT')
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK')
      throw error
    }
    for (const job of records)
      if (job.jsonl && workerData.root) {
        fs.mkdirSync(workerData.root, { recursive: true })
        const file = path.join(workerData.root, `${job.summary.ts.slice(0, 10)}.jsonl`)
        fs.appendFileSync(file, JSON.stringify(job.summary) + '\n', { mode: 0o600 })
      }
    metrics.write_ms += performance.now() - writeAt
    checkpoint()
    parentPort.postMessage({ id, metrics, omitted })
  } catch (error) {
    parentPort.postMessage({ id, error: error.message })
  }
})
parentPort.postMessage({ type: 'ready' })
