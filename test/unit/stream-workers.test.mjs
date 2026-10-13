import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StreamWorkers } from '../../src/lib/transport/stream-workers.mjs'
import { streamGoWorker, cancelWorkerRequest } from '../../src/lib/transport/go-worker-client.mjs'
import { fakeStreamKernel } from '../helpers/fake-stream-kernel.mjs'

async function setup(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-stream-test-'))
  const upstream = await fakeStreamKernel(root, options)
  const pool = new StreamWorkers({ size: 2, cancel: cancelWorkerRequest })
  await pool.start()
  t.after(async () => {
    await pool.close()
    await upstream.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const args = {
    exec: upstream.exec,
    body: { model: 'test-gpt' },
    envelope: { body: { model: 'test-gpt' }, stream: true },
    requestPath: '/internal/v1/codex/responses',
  }
  return { pool, upstream, args }
}

test('worker transport preserves SSE order, cache usage, trailers and session envelope', async (t) => {
  const { pool, upstream, args } = await setup(t)
  args.envelope.session = { session_id: 'stable-cache-home' }
  const directLines = [],
    workerLines = []
  const direct = await streamGoWorker({ ...args, onEvent: (line) => directLines.push(line) })
  const offloaded = await pool.run({
    ...args,
    onEvent: (line) => workerLines.push(line),
    ensureCredential: () => assert.fail('credential refresh belongs to the owner'),
    ensureRust: () => assert.fail('kernel lifecycle belongs to the owner'),
  })
  assert.deepEqual(workerLines, directLines)
  for (const key of ['ok', 'status', 'usage', 'headers', 'body', 'committed', 'terminalState']) {
    assert.deepEqual(offloaded[key], direct[key], key)
  }
  assert.equal(upstream.stats.bodies[1].session.session_id, 'stable-cache-home')
  assert.equal(pool.snapshot().active, 0)
})

test('slow downstream backpressure and cancellation release a worker task', async (t) => {
  const { pool, upstream, args } = await setup(t, { chunks: 100, intervalMs: 10 })
  const controller = new AbortController()
  let lines = 0
  const result = await pool.run({
    ...args,
    signal: controller.signal,
    onEvent: async () => {
      lines++
      await new Promise((resolve) => setTimeout(resolve, 10))
      if (lines === 4) controller.abort()
    },
  })
  assert.equal(result.terminalState, 'cancelled')
  assert.ok(upstream.stats.cancels.length > 0)
  assert.equal(pool.snapshot().active, 0)
  assert.ok(lines < 50)
})

test('worker death cancels the exact upstream request and never silently replays it', async (t) => {
  const { pool, upstream, args } = await setup(t, { chunks: 100, intervalMs: 10 })
  let started
  const seen = new Promise((resolve) => {
    started = resolve
  })
  const run = pool.run({ ...args, onEvent: () => started() })
  const rejected = assert.rejects(run, /stream worker exited/)
  await seen
  const entry = pool.workers.find((worker) => worker.tasks.size)
  await entry.worker.terminate()
  await rejected
  assert.equal(upstream.stats.started, 1)
  assert.ok(upstream.stats.cancels.includes(upstream.stats.bodies[0].request_id))
  assert.equal(pool.snapshot().active, 0)
  await pool.run({ ...args, onEvent: () => {} })
  assert.equal(upstream.stats.started, 2)
})
