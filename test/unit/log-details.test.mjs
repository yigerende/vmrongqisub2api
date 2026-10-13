import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { buildDebugRecord } from '../../src/lib/admin/debug-record.mjs'
import { LogDetails, LogDetailsPool, detailBytes } from '../../src/lib/db/log-details.mjs'
import { encodeDebugJson, decodeDebugJson } from '../../src/lib/db/debug-codec.mjs'

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

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-details-test-'))
  const dbPath = path.join(root, 'kin.db')
  const db = createDatabase({ dbPath })
  const store = new RequestLogStore({ db, dataDir: root, mode: 'debug', ...options })
  t.after(async () => {
    await store.closeWriter()
    await store.closeReader()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, dbPath, db, store }
}

test('debug construction, redaction, JSONL, and cleanup never use the serving connection', async (t) => {
  const { root, dbPath, store } = fixture(t, { jsonlMirror: true })
  store.enableReader(dbPath)
  store.enableWriter(dbPath)
  store.repo.insertDebug = () => assert.fail('debug insert on owner')
  store.repo.cleanup = () => assert.fail('cleanup on owner')
  store._appendJsonl = () => assert.fail('JSONL on owner')
  store._cleanupLegacyFiles = () => assert.fail('file cleanup on owner')
  const body = { input: 'hello', authorization: 'Bearer original-secret' }
  const ctx = store.start({ headers: { 'x-request-id': 'immutable', authorization: 'Bearer header-secret' } })
  store.finish(ctx, { inbound_body: body, outbound_body: body, status: 200, usage: { input_tokens: 42 } })
  body.input = 'changed after finish'
  const rec = await store.read('getDebug', 'immutable')
  assert.equal(rec.inbound_body.input, 'hello')
  assert.equal(rec.outbound_body.input, 'hello')
  assert.equal(rec.headers.authorization, '***REDACTED***')
  assert.equal(rec.request_body_snapshot.authorization, '[REDACTED]')
  assert.doesNotMatch(JSON.stringify(rec), /original-secret|header-secret/)
  const file = path.join(root, 'request-logs', `${new Date().toISOString().slice(0, 10)}.jsonl`)
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8').trim()).input_tokens, 42)
  assert.equal((await store.cleanup()).request_log_debug, 0)
  assert.equal(store.details.snapshot().dropped_records, 0)
})

test('a paused debug worker cannot hold up usage reports or summary durability', async (t) => {
  const { dbPath, store } = fixture(t)
  store.enableWriter(dbPath)
  store.enableReader(dbPath)
  await store.details.close()
  const worker = new ControlledWorker()
  store.details = new LogDetails(dbPath, { createWorker: () => worker })
  store.finish(store.start({ headers: { 'x-request-id': 'independent' } }), {
    status: 200,
    inbound_body: { input: 'x'.repeat(190000) },
  })
  const report = await store.read('queryNormal')
  assert.equal(report.total, 1)
  assert.equal(store.details.persisted, 0)
  worker.emit('message', { type: 'ready' })
  const message = worker.messages[0]
  worker.emit('message', { id: message.id })
  await store.details.flush()
})

test('bounded debug overflow never falls back to the owner; COMMIT-before-ACK replay preserves repeated-id order', async (t) => {
  const { dbPath, store } = fixture(t)
  const workers = []
  const writer = new LogDetails(dbPath, {
    maxRows: 2,
    retryMs: 1,
    createWorker: () => {
      const worker = new ControlledWorker()
      workers.push(worker)
      return worker
    },
  })
  t.after(() => writer.close())
  const job = (text) => ({
    summary: { request_id: 'same-id', ts: new Date().toISOString() },
    debug: { ctx: {}, extra: { inbound_body: { input: text } }, maxDebugBodyChars: 200000 },
  })
  const original = job('first')
  assert.equal(writer.enqueue(original), true)
  original.debug.extra.inbound_body.input = 'mutated'
  workers[0].emit('message', { type: 'ready' })
  const pending = writer.flush()
  assert.equal(writer.enqueue(job('second')), true)
  assert.equal(writer.enqueue(job('overflow')), false)
  assert.equal(writer.snapshot().dropped_records, 1)
  assert.ok(writer.bytes <= writer.maxBytes)
  const persist = (message) => {
    for (const job of message.jobs)
      store.repo.insertDebug('same-id', job.summary.ts, buildDebugRecord(job.summary, job.debug))
  }
  persist(workers[0].messages[0])
  const rejected = assert.rejects(pending, /exited/)
  await workers[0].terminate()
  await rejected
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(workers.length, 2)
  workers[1].emit('message', { type: 'ready' })
  const replay = workers[1].messages[0]
  assert.equal(replay.jobs[0].debug.extra.inbound_body.input, 'first')
  persist(replay)
  workers[1].emit('message', { id: replay.id })
  await writer.flush()
  assert.equal(store.repo.getDebug('same-id').inbound_body.input, 'second')
  assert.equal(writer.bytes, 0)
})

test('debug flush only waits for the records accepted when called', async (t) => {
  const worker = new ControlledWorker()
  const writer = new LogDetails('unused', { createWorker: () => worker })
  t.after(() => writer.close())
  worker.emit('message', { type: 'ready' })
  writer.enqueue({ summary: { request_id: 'a' } })
  const earlier = writer.flush()
  writer.enqueue({ summary: { request_id: 'b' } })
  worker.emit('message', { id: worker.messages[0].id })
  await earlier
  assert.equal(writer.persisted, 1)
  assert.equal(writer.enqueued, 2)
  worker.emit('message', { id: worker.messages[1].id })
  await writer.flush()
})

test('pipeline replay includes every unacknowledged batch in order', async (t) => {
  const workers = []
  const writer = new LogDetails('unused', {
    retryMs: 1,
    createWorker: () => {
      const worker = new ControlledWorker()
      workers.push(worker)
      return worker
    },
  })
  t.after(() => writer.close())
  workers[0].emit('message', { type: 'ready' })
  for (let i = 0; i < 6; i++) {
    writer.enqueue({ summary: { request_id: 'same', order: i } })
    writer.pump()
  }
  assert.equal(workers[0].messages.length, 4)
  workers[0].emit('message', { id: workers[0].messages[0].id })
  const pending = writer.flush()
  const rejected = assert.rejects(pending, /exited/)
  await workers[0].terminate()
  await rejected
  await new Promise((resolve) => setTimeout(resolve, 20))
  workers[1].emit('message', { type: 'ready' })
  assert.deepEqual(
    workers[1].messages.flatMap((message) => message.jobs.map((job) => job.summary.order)),
    [1, 2, 3, 4, 5],
  )
  for (const message of workers[1].messages) workers[1].emit('message', { id: message.id })
  await writer.flush()
  assert.equal(writer.bytes, 0)
})

test('parallel detail workers keep every repeated request id on the same writer', async (t) => {
  const workers = []
  const pool = new LogDetailsPool('unused', {
    createWorker: () => {
      const worker = new ControlledWorker()
      workers.push(worker)
      return worker
    },
  })
  t.after(() => pool.close())
  for (const worker of workers) worker.emit('message', { type: 'ready' })
  for (let i = 0; i < 60; i++) pool.enqueue({ summary: { request_id: `key-${i % 10}`, order: i } })
  const flushed = pool.flush()
  const owners = new Map()
  for (const [index, worker] of workers.entries()) {
    for (const message of worker.messages) {
      for (const { summary } of message.jobs) {
        const prev = owners.get(summary.request_id)
        if (prev) {
          assert.equal(prev.index, index)
          assert.ok(prev.order < summary.order)
        }
        owners.set(summary.request_id, { index, order: summary.order })
      }
      worker.emit('message', { id: message.id })
    }
  }
  await flushed
  assert.equal(new Set([...owners.values()].map((entry) => entry.index)).size, 2)
  assert.equal(pool.snapshot().persisted_records, 60)
})

test('failed worker messaging cannot throw from the serving event loop or discard accepted records', async () => {
  const worker = new ControlledWorker()
  worker.postMessage = () => {
    throw new Error('test closed message port')
  }
  const writer = new LogDetails('unused', { createWorker: () => worker })
  worker.emit('message', { type: 'ready' })
  writer.enqueue({ summary: { request_id: 'retained' } })
  await assert.rejects(writer.flush(), /exited/)
  assert.equal(writer.queue.length, 1)
  assert.ok(writer.bytes > 0)
  await assert.rejects(writer.close(), /exited/)
})

test('retention cannot delete a newer repeated-id record selected by an earlier cleanup step', (t) => {
  const { store } = fixture(t)
  store.repo.insertDebug('repeat', '2020-01-01T00:00:00Z', { old: true })
  const selected = store.repo._oldDebugBatch.all('2021-01-01T00:00:00Z', 8)
  store.repo.insertDebug('repeat', new Date().toISOString(), { fresh: true })
  assert.equal(store.repo._deleteDebugChunk(selected).count, 0)
  assert.equal(store.repo.getDebug('repeat').fresh, true)
})

test('retention counts UTF-8 bytes via its index and deletes oldest records in bounded steps', async (t) => {
  const { dbPath, db, store } = fixture(t, { maxMb: 1 })
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400_000).toISOString()
  const nineDaysAgo = new Date(Date.now() - 9 * 86400_000).toISOString()
  store.repo.insertSummary({ id: 'keep', request_id: 'keep', ts: fiveDaysAgo })
  store.repo.insertSummary({ id: 'expire', request_id: 'expire', ts: nineDaysAgo })
  store.repo.insertDebug('keep', fiveDaysAgo, { text: 'old debug' })
  for (let i = 0; i < 20; i++)
    store.repo.insertDebug(`new-${i}`, new Date(Date.now() - (20 - i) * 1000).toISOString(), {
      text: '汉'.repeat(40000),
    })
  const expected = db
    .prepare('SELECT record_json FROM request_log_debug')
    .all()
    .reduce((n, row) => n + Buffer.byteLength(row.record_json), 0)
  assert.equal(store.repo.debugBytes(), expected)
  const plan = db
    .prepare(
      'EXPLAIN QUERY PLAN SELECT SUM(LENGTH(CAST(record_json AS BLOB))) FROM request_log_debug INDEXED BY idx_reqdbg_retention',
    )
    .all()
  assert.ok(plan.some((row) => row.detail.includes('idx_reqdbg_retention')))
  store.enableWriter(dbPath)
  const result = await store.cleanup()
  assert.equal(result.usage_logs, 1)
  assert.equal(result.debug_by_age, 1)
  assert.ok(result.debug_by_size > 0)
  assert.ok(store.repo.debugBytes() <= 1024 * 1024)
  assert.equal(store.repo.getDebug('keep'), null)
  assert.equal(store.repo.getDebug('new-0'), null)
  assert.ok(store.repo.getDebug('new-19'))
  assert.ok(store.repo.getByRequestId('keep'))
  assert.equal(store.repo.getByRequestId('expire'), null)
})

test('captured UTF-8 frames are decoded in order and retain the existing character limit', async (t) => {
  const { dbPath, store } = fixture(t, { maxDebugBodyChars: 5 })
  store.enableWriter(dbPath)
  const res = new EventEmitter()
  res.write = () => true
  res.end = () => res.emit('finish')
  res.getHeaders = () => ({ 'set-cookie': 'secret' })
  res.statusCode = 200
  const ctx = store.start({ headers: {} })
  store.tapResponse(ctx, res)
  const bytes = Buffer.from('汉字🙂尾abc')
  for (const b of bytes) res.write(Buffer.from([b]))
  res.end()
  store.finish(ctx, { status: 200 })
  await store.details.flush()
  const rec = store.getDebug(ctx.request_id)
  assert.equal(rec.response.body, '汉字🙂尾')
  assert.equal(rec.response.bytes, bytes.length)
  assert.equal(rec.response.truncated, true)
  assert.equal(rec.response.headers['set-cookie'], '***REDACTED***')
})

test('oversized and deeply nested debug payloads are rejected before cloning or serialization', () => {
  assert.throws(() => detailBytes({ body: 'x'.repeat(5000) }, 1024), /too large/)
  const root = {}
  let child = root
  for (let i = 0; i < 100; i++) {
    child.next = {}
    child = child.next
  }
  assert.throws(() => detailBytes(root, 1024 * 1024), /too large/)
  const circular = {}
  circular.self = circular
  assert.ok(detailBytes(circular, 1024) <= 1024)
})

test('compressed debug records and legacy JSON have identical public results and actual-byte retention', async (t) => {
  const { dbPath, db, store } = fixture(t)
  const text = 'code and instructions 汉字\n'.repeat(4000)
  const json = JSON.stringify({ input: text })
  const packed = encodeDebugJson(json)
  assert.ok(packed instanceof Uint8Array)
  assert.deepEqual(decodeDebugJson(packed), JSON.parse(json))
  assert.deepEqual(decodeDebugJson(json), JSON.parse(json))
  store.repo.insertDebug('legacy', new Date().toISOString(), { input: text })
  store.enableWriter(dbPath)
  store.enableReader(dbPath)
  store.finish(store.start({ headers: { 'x-request-id': 'packed' } }), { inbound_body: { input: text }, status: 200 })
  const rec = await store.read('getDebug', 'packed')
  assert.equal(rec.inbound_body.input, text)
  assert.equal(
    db.prepare('SELECT typeof(record_json) AS type FROM request_log_debug WHERE request_id = ?').get('packed').type,
    'blob',
  )
  assert.equal((await store.read('listDebug', { include_muted: true })).length, 2)
  assert.ok(store.repo.debugBytes() < Buffer.byteLength(json) * 1.1)
})

test('an unserializable diagnostic payload is counted and cannot block following records', async (t) => {
  const { dbPath, store } = fixture(t)
  store.enableWriter(dbPath)
  store.finish(store.start({ headers: { 'x-request-id': 'invalid' } }), { status: 200, hop_meta: { bigint: 1n } })
  store.finish(store.start({ headers: { 'x-request-id': 'following' } }), {
    status: 200,
    inbound_body: { input: 'valid' },
  })
  await store.details.flush()
  await store.writer.flush()
  assert.equal(store.count(), 2)
  assert.equal(store.repo.getDebug('following').inbound_body.input, 'valid')
  assert.equal(store.details.snapshot().dropped_records, 1)
  assert.equal(store.details.snapshot().restarts, 0)
})

test('close drains debug writes and a restored binding starts fresh workers', async (t) => {
  const { dbPath, db, store } = fixture(t)
  store.enableWriter(dbPath)
  store.finish(store.start({ headers: { 'x-request-id': 'before-restore' } }), {
    status: 200,
    inbound_body: { input: 'one' },
  })
  await store.closeWriter()
  assert.equal(store.repo.getDebug('before-restore').inbound_body.input, 'one')
  store.rebind(db)
  store.finish(store.start({ headers: { 'x-request-id': 'after-restore' } }), {
    status: 200,
    inbound_body: { input: 'two' },
  })
  await store.closeWriter()
  assert.equal(store.repo.getDebug('after-restore').inbound_body.input, 'two')
})
