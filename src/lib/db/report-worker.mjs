import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { RequestLogStore } from '../admin/request-log.mjs'
import { UsageLogsView } from './repos/usage-logs-view.mjs'
import { StatisticsRepo } from './repos/statistics-repo.mjs'

const allowed = {
  log: new Set([
    'queryNormal',
    'exportRows',
    'aggregate',
    'totals',
    'hasSuccessfulRequest',
    'billingStats',
    'ownerBilling',
    'costByModel',
    'vmUsageStats',
    'keyUsageStats',
    'windowStats',
    'protocolEntryStats',
    'listDebug',
    'getDebug',
    'count',
  ]),
  view: new Set(['listBatch', 'summary', 'filterOptions', 'sessionSuggestions', 'activeSessions', 'overview']),
  statistics: new Set(['statistics', 'leaderboard']),
}
const db = new DatabaseSync(workerData.dbPath)
db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000')
const logs = new RequestLogStore({ db })
const stats = new StatisticsRepo(db)

parentPort.on('message', ({ id, kind, method, args, options }) => {
  try {
    if (!allowed[kind]?.has(method)) throw new Error('unsupported report query')
    logs.mutedErrorClasses = options?.mutedErrorClasses || []
    const target = kind === 'log' ? logs : kind === 'statistics' ? stats : new UsageLogsView(db, options)
    // Preserve the existing idempotent legacy-cost backfill before billing.
    // All other report methods remain query-only; there is no new billing path.
    if (kind === 'log' && method === 'billingStats') db.exec('PRAGMA query_only = OFF')
    const value = target[method](...args)
    parentPort.postMessage({ id, value })
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } })
  } finally {
    db.exec('PRAGMA query_only = ON')
  }
})
