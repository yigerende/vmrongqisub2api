import { withTransaction } from './database.mjs'

export function persistLogBatch(db, repo, rows) {
  withTransaction(db, () => {
    for (const row of rows) {
      repo.insertSummaryIfAbsent(row.summary)
    }
  })
}
