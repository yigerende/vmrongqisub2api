import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { createVmQualityMonitor } from '../../src/lib/admin/vm-quality.mjs'
import { changeVmQualitySchedule } from '../../src/lib/admin/vm-quality-schedule.mjs'
import { qualityIdentity } from '../../src/lib/admin/vm-quality-identity.mjs'
import {
  getVm,
  listVms,
  patchVmRecord,
  setVmSchedulable,
  syncCodexQuotaSchedule,
} from '../../src/lib/vm/vm-registry.mjs'
import { pickCodexCandidates } from '../../src/lib/protocol/handle-codex.mjs'

function fixture(t, { platform = 'openai', runProbe } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-quality-schedule-'))
  const id = 'vm-quality'
  const dir = path.join(root, 'vms', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      platform,
      created_at: '2026-10-12',
      assignment_id: 'assignment-a',
      execution_mode: platform === 'openai' ? 'docker_per_slot' : undefined,
      status: 'running',
      schedulable: true,
      schedule_manual: true,
      proxy: { id: 'px-local', scheme: 'local', host: 'local' },
      proxy_cli_enabled: true,
      claude: { has_access: true, email: 'claude@example.test' },
      fingerprint: { guest_machine_id: 'machine-a' },
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'codex-credentials.json'),
    JSON.stringify({ accounts: [{ access_token: 'test-at', refresh_token: 'test-rt', email: 'codex@example.test' }] }),
  )
  const dbPath = path.join(root, 'quality.db')
  let db = createDatabase({ dbPath })
  let monitor
  let verdict = 'degraded'
  let time = Date.now()
  const errors = []
  const start = () =>
    createVmQualityMonitor({
      db,
      listTargets: () => listVms(root),
      now: () => time,
      changeSchedule: (vm, enabled) => changeVmQualitySchedule(root, vm, enabled),
      runProbe:
        runProbe ||
        (async ({ question }) =>
          verdict === 'error'
            ? { ok: false, error: { message: 'timeout' } }
            : { ok: true, complete: true, text: verdict === 'normal' ? question.answer : 'wrong', duration_ms: 10 }),
      onError: (...args) => errors.push(args),
    })
  monitor = start()
  t.after(async () => {
    monitor.stop()
    await monitor.idle()
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
    assert.deepEqual(errors, [])
  })
  return {
    root,
    id,
    get monitor() {
      return monitor
    },
    vm: () => getVm(root, id),
    snapshot: () => monitor.history(id),
    config(patch = {}) {
      monitor.setConfig({ ...monitor.getConfig(), pause_on_degraded: true, ...patch })
    },
    async run(status = 'degraded', source = 'manual') {
      verdict = status
      if (source === 'auto') {
        time += 86400000
        monitor.tick()
      } else monitor.enqueue(id)
      await monitor.idle()
    },
    restart() {
      monitor.stop()
      db.close()
      db = createDatabase({ dbPath })
      monitor = start()
    },
  }
}

test('red and green thresholds persist over restart, ignore yellow, and both manual/auto checks count', async (t) => {
  const f = fixture(t)
  f.config({ recovery_limit: 2, history_limit: 1 })
  f.monitor.setEnabled([f.id], true)
  await f.run('degraded', 'auto')
  assert.equal(f.vm().schedulable, true)
  assert.equal(f.snapshot().failure_streak, 1)
  f.restart()
  await f.run('error')
  assert.equal(f.snapshot().failure_streak, 1)
  await f.run('degraded')
  assert.equal(f.vm().schedulable, false)
  assert.equal(f.vm().status, 'running')
  assert.equal(f.snapshot().paused_by_quality, true)
  f.restart()
  await f.run('normal', 'auto')
  assert.equal(f.vm().schedulable, false)
  assert.equal(f.snapshot().recovery_streak, 1)
  await f.run('error')
  assert.equal(f.snapshot().recovery_streak, 1)
  await f.run('normal', 'auto')
  assert.equal(f.vm().schedulable, true)
  assert.equal(f.vm().schedule_manual, true, 'retain the previous manual switch policy')
  assert.equal(f.snapshot().paused_by_quality, false)
  assert.equal(f.snapshot().history.length, 1, 'streaks must not depend on retained history')
})

test('green breaks a red streak and red breaks a recovery streak', async (t) => {
  const f = fixture(t)
  f.config({ recovery_limit: 2 })
  await f.run('degraded')
  await f.run('normal')
  await f.run('degraded')
  assert.equal(f.vm().schedulable, true)
  await f.run('degraded')
  await f.run('normal')
  await f.run('degraded')
  await f.run('normal')
  assert.equal(f.vm().schedulable, false)
  assert.equal(f.snapshot().recovery_streak, 1)
  await f.run('normal')
  assert.equal(f.vm().schedulable, true)
})

test('disabled policy only records; disabling it never turns a paused slot back on', async (t) => {
  const f = fixture(t)
  const before = f.vm()
  await f.run()
  await f.run()
  assert.deepEqual(f.vm(), before)
  f.config({ failure_limit: 1 })
  await f.run()
  f.config({ pause_on_degraded: false })
  await f.run('normal')
  assert.equal(f.vm().schedulable, false)
  assert.equal(f.snapshot().failure_streak, 0)
  f.config()
  await f.run('normal')
  assert.equal(f.vm().schedulable, true)
})

test('manual pauses before or after quality suspension can never be automatically enabled', async (t) => {
  const f = fixture(t)
  f.config({ failure_limit: 1 })
  setVmSchedulable(f.root, f.id, false, 'manual', { preserveStatus: true, source: 'manual' })
  await f.run()
  await f.run('normal')
  assert.equal(f.vm().schedulable, false)
  assert.equal(f.snapshot().paused_by_quality, false)
  setVmSchedulable(f.root, f.id, true, null, { preserveStatus: true, source: 'manual' })
  await f.run()
  assert.equal(f.snapshot().paused_by_quality, true)
  // Even a client passing the same reason cannot retain quality ownership.
  setVmSchedulable(f.root, f.id, false, 'quality_degraded', { preserveStatus: true, source: 'manual' })
  await f.run('normal')
  assert.equal(f.vm().schedulable, false)
  assert.equal(f.snapshot().paused_by_quality, false)
})

test('manual enabling and configuration edits require a fresh complete failure streak', async (t) => {
  const f = fixture(t)
  f.config()
  await f.run()
  await f.run()
  setVmSchedulable(f.root, f.id, true, null, { preserveStatus: true, source: 'manual' })
  await f.run()
  assert.equal(f.vm().schedulable, true)
  assert.equal(f.snapshot().failure_streak, 1)
  f.config({ model: 'gpt-6.1-sol' })
  await f.run()
  assert.equal(f.vm().schedulable, true)
  await f.run()
  assert.equal(f.vm().schedulable, false)
})

test('late results cannot override operator edits, config changes or disabled automatic checks', async (t) => {
  for (const edit of ['schedule', 'config', 'off']) {
    await t.test(edit, async (t) => {
      let finish
      const f = fixture(t, {
        runProbe: () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      })
      f.config({ failure_limit: 1 })
      f.monitor.setEnabled([f.id], true)
      f.monitor.tick()
      await new Promise((resolve) => queueMicrotask(resolve))
      if (edit === 'schedule') setVmSchedulable(f.root, f.id, true, null, { preserveStatus: true, source: 'manual' })
      if (edit === 'config') f.config({ model: 'new-model' })
      if (edit === 'off') f.monitor.setEnabled([f.id], false)
      finish({ ok: true, complete: true, text: 'wrong', duration_ms: 10 })
      await f.monitor.idle()
      assert.equal(f.vm().schedulable, true)
      assert.equal(f.snapshot().failure_streak, 0)
      assert.equal(f.snapshot().history.length, 1)
    })
  }
})

test('reset/replacement clears streaks and cannot inherit quality pause ownership', async (t) => {
  const f = fixture(t)
  f.config()
  await f.run()
  patchVmRecord(f.root, f.id, { fingerprint: { guest_machine_id: 'machine-b' } })
  await f.run()
  assert.equal(f.vm().schedulable, true)
  assert.equal(f.snapshot().failure_streak, 1)
  await f.run()
  patchVmRecord(f.root, f.id, { assignment_id: 'assignment-b' })
  await f.run('normal')
  assert.equal(f.snapshot().paused_by_quality, false)
  assert.equal(f.vm().schedulable, false)
})

test('stopped/deleting/missing-credential slots and other suspension reasons never get restored', async (t) => {
  for (const patch of [{ status: 'stopped' }, { status: 'deleting' }, { schedule_disabled_reason: 'proxy_required' }]) {
    await t.test(JSON.stringify(patch), async (t) => {
      const f = fixture(t)
      f.config({ failure_limit: 1 })
      await f.run()
      patchVmRecord(f.root, f.id, patch)
      await f.run('normal')
      assert.equal(f.vm().schedulable, false)
    })
  }
  const f = fixture(t)
  f.config({ failure_limit: 1 })
  await f.run()
  fs.writeFileSync(path.join(f.root, 'vms', f.id, 'codex-credentials.json'), '{"accounts":[]}')
  await f.run('normal')
  assert.equal(f.vm().schedulable, false)
})

test('quality pause blocks ordinary GPT routing, permits pinned recovery and survives quota/auto-enable', async (t) => {
  const f = fixture(t)
  patchVmRecord(f.root, f.id, { schedule_manual: false })
  f.config({ failure_limit: 1 })
  await f.run()
  const pick = (headers) =>
    pickCodexCandidates(f.root, { apiKeyKind: 'master', headers }, { body: { model: 'gpt-5.4' } })
  assert.deepEqual(pick({}).ids, [])
  assert.deepEqual(pick({ 'x-kin-vm': f.id }).ids, [f.id])
  setVmSchedulable(f.root, f.id, true)
  syncCodexQuotaSchedule(f.root, f.vm())
  assert.equal(f.vm().schedulable, false)
  await f.run('normal')
  assert.deepEqual(pick({}).ids, [f.id])
})

test('Claude slots use the same thresholds and maintain running status', async (t) => {
  const f = fixture(t, { platform: 'anthropic' })
  f.config({ failure_limit: 1 })
  await f.run()
  assert.equal(f.vm().status, 'running')
  assert.equal(f.vm().schedule_quality_identity, qualityIdentity(listVms(f.root)[0]))
  await f.run('normal')
  assert.equal(f.vm().schedulable, true)
})
