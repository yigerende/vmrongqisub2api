import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { LogWriter } from '../../src/lib/db/log-writer.mjs'
import { persistLogBatch } from '../../src/lib/db/persist-log-batch.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'

class ControlledWorker extends EventEmitter {
  messages = []
  ref() {}
  unref() {}
  postMessage(message) {
    this.messages.push(message)
  }
  async terminate() {
    this.emit('exit', 1)
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-writer-test-'))
  const dbPath = path.join(root, 'kin.db')
  const db = createDatabase({ dbPath })
  const store = new RequestLogStore({ db, dataDir: root, mode: 'debug' })
  t.after(async () => {
    await store.closeWriter()
    await store.closeReader()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const finish = (id, tokens = 10) =>
    store.finish(store.start({ headers: { 'x-request-id': id } }), {
      status: 200,
      model: 'gpt-5.4',
      user_id: 1,
      usage: { input_tokens: 100, output_tokens: tokens },
      inbound_body: { input: 'hello', access_token: 'secret-test-token' },
    })
  return { store, dbPath, db, finish }
}

test('background summaries flush before reports and preserve debug redaction and repeated request ids', async (t) => {
  const { store, dbPath, finish } = fixture(t)
  store.enableReader(dbPath)
  store.enableWriter(dbPath)
  for (let i = 0; i < 80; i++) finish(`req-${i}`)
  finish('req-0', 99)
  assert.equal((await store.read('queryNormal', { limit: 100 })).total, 80)
  assert.equal(store.repo.getByRequestId('req-0').output_tokens, 10)
  const debug = await store.read('getDebug', 'req-0')
  assert.equal(debug.output_tokens, 99)
  assert.equal(debug.request_body_snapshot.access_token, '[REDACTED]')
  assert.deepEqual(await store.read('totals'), store.totals())
  assert.equal(store.writer.bytes, 0)
})

test('a writer crash after COMMIT replays retained ids without double counting', async (t) => {
  const { store, dbPath, db, finish } = fixture(t)
  const worker = new ControlledWorker()
  store.writer = new LogWriter(dbPath, (rows) => persistLogBatch(db, store.repo, rows), { createWorker: () => worker })
  worker.emit('message', { type: 'ready' })
  finish('first')
  const pending = store.writer.flush()
  persistLogBatch(db, store.repo, worker.messages[0].rows)
  await worker.terminate()
  await pending
  assert.equal(store.count(), 1)
  assert.equal(store.writer.fallbacks, 1)
  assert.equal(store.writer.bytes, 0)
})

test('bounded overflow preserves order and flush is a barrier under continuous writes', async (t) => {
  const { store, dbPath, db, finish } = fixture(t)
  const worker = new ControlledWorker()
  store.writer = new LogWriter(dbPath, (rows) => persistLogBatch(db, store.repo, rows), {
    createWorker: () => worker,
    maxRows: 2,
  })
  worker.emit('message', { type: 'ready' })
  finish('first')
  const firstFlush = store.writer.flush()
  const firstBatch = worker.messages[0]
  finish('second')
  finish('third') // bounded synchronous fallback of first + second
  await firstFlush
  assert.equal(store.count(), 2)
  persistLogBatch(db, store.repo, firstBatch.rows)
  worker.emit('message', { id: firstBatch.id })
  assert.equal(store.count(), 2)
  const thirdFlush = store.writer.flush()
  finish('fourth')
  const thirdBatch = worker.messages[1]
  persistLogBatch(db, store.repo, thirdBatch.rows)
  worker.emit('message', { id: thirdBatch.id })
  await thirdFlush // fourth is still pending, without starving this earlier read
  assert.equal(store.count(), 3)
  const fourthBatch = worker.messages[2]
  persistLogBatch(db, store.repo, fourthBatch.rows)
  worker.emit('message', { id: fourthBatch.id })
  await store.writer.flush()
  assert.equal(store.count(), 4)
})

test('failed fallback retains unacknowledged rows and retries after storage recovery', async (t) => {
  const { store, dbPath, db, finish } = fixture(t)
  const worker = new ControlledWorker()
  let diskFailed = true
  store.writer = new LogWriter(
    dbPath,
    (rows) => {
      if (diskFailed) throw new Error('test disk unavailable')
      persistLogBatch(db, store.repo, rows)
    },
    { createWorker: () => worker },
  )
  worker.emit('message', { type: 'ready' })
  finish('recoverable')
  const pending = store.writer.flush()
  const rejection = assert.rejects(pending, /disk unavailable/)
  await worker.terminate()
  await rejection
  assert.equal(store.writer.queue.length, 1)
  diskFailed = false
  await store.writer.flush()
  assert.equal(store.count(), 1)
})

test('a stalled writer is reaped and flushed on the owner connection', async (t) => {
  const { store, dbPath, db, finish } = fixture(t)
  const worker = new ControlledWorker()
  store.writer = new LogWriter(dbPath, (rows) => persistLogBatch(db, store.repo, rows), {
    createWorker: () => worker,
    timeoutMs: 30,
  })
  const keepAlive = setInterval(() => {}, 100)
  t.after(() => clearInterval(keepAlive))
  finish('timeout')
  await store.writer.flush()
  assert.equal(store.count(), 1)
  assert.equal(store.writer.worker, null)
})
