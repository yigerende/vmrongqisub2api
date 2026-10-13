import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { UsageLogsRepo } from './repos/usage-logs-repo.mjs'
import { persistLogBatch } from './persist-log-batch.mjs'

const db = new DatabaseSync(workerData.dbPath)
db.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON')
const repo = new UsageLogsRepo(db)
parentPort.on('message', ({ id, rows }) => {
  try {
    persistLogBatch(db, repo, rows)
    parentPort.postMessage({ id })
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } })
  }
})
parentPort.postMessage({ type: 'ready' })
