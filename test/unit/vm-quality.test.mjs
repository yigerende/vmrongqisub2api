import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { createVmQualityMonitor } from '../../src/lib/admin/vm-quality.mjs'
import {
  DEFAULT_QUALITY_CONFIG,
  evaluateQuality,
  qualityAnswerMatch,
  validateQualityConfig,
} from '../../src/lib/admin/vm-quality-config.mjs'
import { handleVmQuality } from '../../src/lib/admin/vm-quality-routes.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

const normal = (question) => ({ ok: true, complete: true, text: question.answer, duration_ms: 20 })
const slot = (id) => ({
  id,
  status: 'running',
  has_token: true,
  platform: 'openai',
  created_at: '2026-10-12',
  email: `${id}@example.test`,
  schedulable: true,
})
function fixture(t, options = {}) {
  const db = createDatabase({ dbPath: ':memory:' })
  const vms = [slot('vm-a'), slot('vm-b')]
  const errors = []
  const monitor = createVmQualityMonitor({
    db,
    listTargets: () => vms,
    runProbe: async ({ question }) => normal(question),
    onError: (...err) => errors.push(err),
    ...options,
  })
  t.after(async () => {
    monitor.stop()
    await monitor.idle()
    db.close()
    assert.deepEqual(errors, [])
  })
  return { db, vms, monitor }
}

test('Qerkai answer matching and strict time threshold distinguish normal/degraded/error', () => {
  const q = validateQualityConfig(DEFAULT_QUALITY_CONFIG)
  const question = q.questions[0]
  assert.equal(qualityAnswerMatch(question, ' 21\n'), true)
  assert.equal(qualityAnswerMatch(question, '解释\nFINAL_ANSWER=21\n'), true)
  assert.equal(qualityAnswerMatch(question, 'FINAL_ANSWER=21\nFINAL_ANSWER=21'), false)
  assert.equal(qualityAnswerMatch({ ...question, match_mode: 'keyword' }, '答案是21'), true)
  assert.equal(qualityAnswerMatch({ ...question, match_mode: 'regex', answer: '^2[01]$' }, '21'), true)
  assert.equal(evaluateQuality(q, question, normal(question)).status, 'normal')
  assert.equal(evaluateQuality(q, question, { ...normal(question), text: '20' }).status, 'degraded')
  assert.equal(evaluateQuality(q, question, { ...normal(question), duration_ms: 20000 }).status, 'degraded')
  assert.equal(
    evaluateQuality({ ...q, mode: 'content' }, question, { ...normal(question), duration_ms: 30000 }).status,
    'normal',
  )
  assert.equal(
    evaluateQuality({ ...q, mode: 'time' }, question, { ...normal(question), text: 'wrong' }).status,
    'normal',
  )
  for (const response of [
    { ok: false, error: { message: 'timeout' } },
    { ...normal(question), complete: false },
    { ...normal(question), text: '' },
    { ...normal(question), text: 'a'.repeat(16385) },
  ]) {
    assert.equal(evaluateQuality(q, question, response).status, 'error')
  }
})

test('configuration rejects invalid bounds/questions/regex and regex execution is bounded', () => {
  for (const patch of [
    { interval_seconds: 0 },
    { concurrency: 33 },
    { default_enabled: 'true' },
    { questions: [] },
    { questions: DEFAULT_QUALITY_CONFIG.questions.map((q) => ({ ...q, enabled: false })) },
    { model: '' },
  ])
    assert.throws(() => validateQualityConfig({ ...DEFAULT_QUALITY_CONFIG, ...patch }))
  const question = { ...DEFAULT_QUALITY_CONFIG.questions[0], match_mode: 'regex', answer: '(' }
  assert.throws(() => validateQualityConfig({ ...DEFAULT_QUALITY_CONFIG, questions: [question] }))
  const verdict = evaluateQuality(
    DEFAULT_QUALITY_CONFIG,
    { ...question, answer: '^(a+)+$' },
    { ok: true, complete: true, text: 'a'.repeat(200) + '!', duration_ms: 10 },
  )
  assert.equal(verdict.status, 'error')
})

test('manual and automatic checks share rotation and persisted history, off still permits manual', async (t) => {
  let time = 1000000
  const calls = []
  const { monitor, vms, db } = fixture(t, {
    now: () => time,
    runProbe: async ({ vm, question }) => {
      calls.push([vm.id, question.id])
      return normal(question)
    },
  })
  const before = structuredClone(vms)
  monitor.enqueue('vm-a')
  await monitor.idle()
  assert.equal(monitor.snapshot(vms[0]).enabled, false)
  assert.equal(monitor.snapshot(vms[0]).history[0].answer, undefined)
  assert.equal(monitor.history('vm-a').history[0].answer, '21')
  monitor.setEnabled(['vm-a'], true)
  monitor.tick()
  await monitor.idle()
  assert.deepEqual(calls, [
    ['vm-a', 'candy'],
    ['vm-a', 'clock'],
  ])
  assert.deepEqual(
    monitor.history('vm-a').history.map((r) => [r.source, r.status]),
    [
      ['manual', 'normal'],
      ['auto', 'normal'],
    ],
  )
  monitor.tick()
  await monitor.idle()
  assert.equal(calls.length, 2)
  time += 300000
  monitor.tick()
  await monitor.idle()
  assert.equal(calls[2][1], 'percent')
  assert.deepEqual(vms, before, 'detection never alters slot scheduling or lifecycle fields')
  monitor.stop()
  const next = createVmQualityMonitor({
    db,
    listTargets: () => vms,
    runProbe: async ({ question }) => normal(question),
  })
  assert.equal(next.history('vm-a').history.length, 3)
  assert.equal(next.history('vm-a').enabled, true)
  next.stop()
})

test('enable all persists new-account default, per-account override and all-off clears it', (t) => {
  const { monitor, vms } = fixture(t)
  assert.equal(monitor.setEnabled([], true, true).count, 2)
  monitor.setEnabled(['vm-a'], false)
  vms.push(slot('vm-c'))
  assert.equal(monitor.snapshot(vms[2]).enabled, true)
  assert.equal(monitor.snapshot(vms[0]).enabled, false)
  assert.equal(monitor.snapshot(vms[1]).enabled, true)
  monitor.setEnabled([], false, true)
  assert.equal(monitor.getConfig().default_enabled, false)
  assert.ok(vms.every((vm) => !monitor.snapshot(vm).enabled))
  assert.throws(() => monitor.setEnabled(['missing'], true), /不存在/)
})

test('one shared concurrency limit, duplicate requests coalesce and queued disabled auto jobs do not run', async (t) => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const calls = []
  const { monitor, vms } = fixture(t, {
    runProbe: async ({ vm, question }) => {
      calls.push(vm.id)
      await gate
      return normal(question)
    },
  })
  monitor.setConfig({ ...monitor.getConfig(), concurrency: 1 })
  monitor.setEnabled([], true, true)
  monitor.tick()
  await new Promise((resolve) => queueMicrotask(resolve))
  assert.deepEqual(calls, ['vm-a'])
  assert.equal(monitor.enqueue('vm-a').queued, false)
  monitor.setEnabled(['vm-b'], false)
  release()
  await monitor.idle()
  assert.deepEqual(calls, ['vm-a'])
  assert.equal(monitor.snapshot(vms[0]).history.length, 1)
  assert.equal(monitor.snapshot(vms[1]).history.length, 0)
})

test('failed requests retry the same question sooner; retained history is bounded', async (t) => {
  let time = 1000000
  let fail = true
  const { monitor, vms } = fixture(t, {
    now: () => time,
    runProbe: async ({ question }) => (fail ? { ok: false, error: { message: 'HTTP 429' } } : normal(question)),
  })
  monitor.setConfig({ ...monitor.getConfig(), history_limit: 2 })
  monitor.setEnabled(['vm-a'], true)
  monitor.tick()
  await monitor.idle()
  assert.equal(monitor.snapshot(vms[0]).next_at, time + 60000)
  assert.equal(monitor.history('vm-a').history[0].status, 'error')
  fail = false
  time += 60000
  monitor.tick()
  await monitor.idle()
  assert.equal(monitor.history('vm-a').history[1].question_id, 'candy')
  monitor.enqueue('vm-a')
  await monitor.idle()
  assert.equal(monitor.history('vm-a').history.length, 2)
  assert.equal(monitor.history('vm-a').history[1].question_id, 'clock')
})

test('deleted or reset/replaced slots reject late results and clean old history', async (t) => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { monitor, vms, db } = fixture(t, {
    runProbe: async ({ question }) => {
      await gate
      return normal(question)
    },
  })
  monitor.enqueue('vm-a')
  monitor.enqueue('vm-b')
  await new Promise((resolve) => queueMicrotask(resolve))
  vms.splice(1, 1)
  vms[0].email = 'replacement@example.test'
  monitor.tick()
  release()
  await monitor.idle()
  assert.equal(monitor.history('vm-a').history.length, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vm_quality_history').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vm_quality_state WHERE vm_id = ?').get('vm-b').n, 0)
})

test('auto checks skip stopped/unauthorized slots and stop prevents late DB writes', async (t) => {
  const { monitor, vms } = fixture(t)
  vms[0].status = 'stopped'
  vms[1].has_token = false
  monitor.setEnabled([], true, true)
  monitor.tick()
  await monitor.idle()
  assert.ok(vms.every((vm) => monitor.snapshot(vm).history.length === 0))
  monitor.enqueue('vm-a')
  monitor.stop()
  await monitor.idle()
  assert.equal(monitor.history('vm-a').history.length, 0)
})

test('quality APIs validate writes, queue manual runs, and existing ACL limits them to admins', async (t) => {
  const { monitor } = fixture(t)
  for (const [method, suffix] of [
    ['GET', 'settings'],
    ['PUT', 'settings'],
    ['POST', 'enable'],
    ['POST', 'vm-a/run'],
    ['GET', 'vm-a/history'],
    ['GET', 'capabilities'],
    ['POST', 'results'],
  ]) {
    const path = `/api/panel/vm-quality/${suffix}`
    assert.equal(authorizePanelRoute(method, path, 'admin').ok, true)
    assert.equal(authorizePanelRoute(method, path, 'user').ok, false)
    assert.equal(authorizePanelRoute(method, path, 'super').ok, false)
  }
  let reply
  const call = async (suffix, method, body) => {
    assert.equal(
      await handleVmQuality({
        req: { method },
        res: {},
        url: new URL(`http://localhost/api/panel/vm-quality/${suffix}`),
        monitor,
        readBody: async () => body,
        json: (_, status, payload) => {
          reply = { status, payload }
        },
      }),
      true,
    )
    return reply
  }
  assert.equal((await call('settings', 'PUT', { concurrency: 0 })).status, 400)
  assert.equal((await call('enable', 'POST', { ids: ['vm-a'], enabled: true })).status, 200)
  assert.equal((await call('enable', 'POST', { ids: ['missing'], enabled: true })).status, 404)
  assert.equal((await call('vm-a/run', 'POST')).status, 202)
  await monitor.idle()
  assert.equal((await call('vm-a/history', 'GET')).payload.data.history[0].source, 'manual')
  assert.equal((await call('capabilities', 'GET')).payload.data.assignment_guard, true)
  assert.equal((await call('results', 'POST', { slots: [] })).status, 400)
})

test('Space results are read-only, assignment guarded and include only the latest completed sample', async (t) => {
  let answer = 'wrong'
  const { monitor, vms, db } = fixture(t, {
    runProbe: async () => ({ ok: true, complete: true, text: answer, duration_ms: 10 }),
  })
  Object.assign(vms[0], { assignment_id: 'cycle-a', execution_mode: 'docker_per_slot' })
  const refs = [{ id: 'vm-a', assignment_id: 'cycle-a' }]
  assert.equal(monitor.results(refs).slots[0].result, null)
  assert.equal(db.prepare('SELECT count(*) AS n FROM vm_quality_state').get().n, 0)
  monitor.enqueue('vm-a')
  await monitor.idle()
  const red = monitor.results(refs)
  assert.equal(red.slots[0].result.status, 'degraded')
  assert.equal(red.slots[0].current, true)
  assert.equal(red.slots[0].result.source, 'manual')
  assert.ok(red.slots[0].result.started_at)
  assert.equal(red.slots[0].result.expected_answer, undefined)
  const denied = monitor.results([{ id: 'vm-a', assignment_id: 'wrong' }]).slots[0]
  assert.deepEqual(denied, { id: 'vm-a', error: 'assignment_mismatch' })
  assert.deepEqual(monitor.results([{ id: 'gone', assignment_id: 'cycle-a' }]).slots, [
    { id: 'gone', error: 'not_found' },
  ])
  answer = '7.5'
  monitor.enqueue('vm-a')
  await monitor.idle()
  assert.equal(monitor.results(refs).slots[0].result.status, 'normal')
  assert.ok(monitor.results(refs).slots[0].result.id > red.slots[0].result.id)
  const reopened = createVmQualityMonitor({
    db,
    listTargets: () => vms,
    runProbe: async () => {
      throw new Error('must not probe')
    },
  })
  t.after(() => reopened.stop())
  assert.equal(reopened.results(refs).revision, red.revision)
  assert.equal(reopened.results(refs).slots[0].current, true)
  monitor.setConfig({ ...monitor.getConfig(), model: 'gpt-6.1-sol' })
  assert.equal(monitor.results(refs).slots[0].current, false)
  vms[0].email = 'replacement@example.test'
  assert.equal(monitor.results(refs).slots[0].result, null)
  assert.throws(() => monitor.results([...refs, ...refs]))
  assert.throws(() => monitor.results([{ id: '../escape', assignment_id: 'cycle-a' }]))
})

test('Space cannot act on samples finishing under an old config or on pre-upgrade history', async (t) => {
  let release
  const { monitor, vms, db } = fixture(t, {
    runProbe: () =>
      new Promise((resolve) => {
        release = resolve
      }),
  })
  Object.assign(vms[0], { assignment_id: 'cycle-a', execution_mode: 'docker_per_slot' })
  const refs = [{ id: 'vm-a', assignment_id: 'cycle-a' }]
  monitor.enqueue('vm-a')
  await new Promise((resolve) => queueMicrotask(resolve))
  monitor.setConfig({ ...monitor.getConfig(), model: 'gpt-6.1-sol' })
  release({ ok: true, complete: true, text: 'wrong', duration_ms: 10 })
  await monitor.idle()
  assert.equal(monitor.results(refs).slots[0].current, false)
  db.prepare('UPDATE vm_quality_history SET payload = ?').run(
    JSON.stringify({ status: 'degraded', checked_at: new Date().toISOString() }),
  )
  assert.equal(monitor.results(refs).slots[0].current, false)
})
