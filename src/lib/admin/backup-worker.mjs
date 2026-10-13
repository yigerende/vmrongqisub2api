import { parentPort, workerData } from 'node:worker_threads'
import { openDatabase, closeDatabase } from '../db/database.mjs'
import { BackupService } from './backup-service.mjs'

try {
  openDatabase({ dbPath: workerData.dbPath })
  const value = new BackupService(workerData.service).createBackup(workerData.options)
  parentPort.postMessage({ value })
} catch (error) {
  parentPort.postMessage({ error: { message: error.message, code: error.code } })
} finally {
  closeDatabase()
}
