import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'

test('offloaded reports preserve ownership, muted errors, pagination and billing results', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-report-test-'))
  const dbPath = path.join(root, 'kin.db')
  const db = createDatabase({ dbPath })
  const store = new RequestLogStore({ db, dataDir: root })
  store.enableReader(dbPath)
  t.after(async () => {
    await store.closeReader()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  for (let i = 0; i < 30; i++) {
    store.finish(store.start({ headers: { 'x-request-id': `request-${i}` } }), {
      status: i % 3 ? 200 : 429,
      user_id: i % 2 ? 1 : 2,
      model: 'gpt-6.1-sol',
      usage: { input_tokens: 100, output_tokens: 10 },
      first_token_ms: i * 10,
      stream: true,
    })
  }
  const opts = { owner_user_id: 1, limit: 7, offset: 2 }
  assert.deepEqual(await store.read('queryNormal', opts), store.queryNormal(opts))
  assert.deepEqual(await store.read('totals'), store.totals())
  db.exec(
    "UPDATE usage_logs SET total_cost = NULL, pricing_model = NULL, model = 'gpt-5.4' WHERE request_id = 'request-1'",
  )
  const billing = { now: new Date('2026-10-13T12:00:00Z') }
  assert.deepEqual(await store.read('billingStats', billing), store.billingStats(billing))
  assert.ok(db.prepare("SELECT total_cost FROM usage_logs WHERE request_id = 'request-1'").get().total_cost > 0)
  const window = { since: '2020-01-01T00:00:00Z', until: '2099-01-01T00:00:00Z', owner_user_id: 2 }
  assert.deepEqual(await store.read('windowStats', window), store.windowStats(window))
  const filters = { owner_user_id: 1, limit: 10 }
  assert.deepEqual(
    await store.readView('view', 'listBatch', filters),
    new UsageLogsView(db, { mutedErrorClasses: store.mutedErrorClasses }).listBatch(filters),
  )
  await assert.rejects(store.read('finish'), /unsupported report query/)
})

test('a report waiting for the writer cannot reopen a connection during restore', async () => {
  let release
  const wait = new Promise((resolve) => {
    release = resolve
  })
  const store = Object.create(RequestLogStore.prototype)
  store.writer = { flush: () => wait }
  store.readerPath = 'must-not-be-opened.db'
  const read = store.read('count')
  store.readerPaused = true
  release()
  await assert.rejects(read, { status: 503 })
  assert.equal(store.reader, undefined)
})
