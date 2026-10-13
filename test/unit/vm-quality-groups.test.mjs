import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { VmPoolsRepo } from '../../src/lib/db/repos/vm-pools-repo.mjs'
import { createVmQualityMonitor } from '../../src/lib/admin/vm-quality.mjs'
import { DEFAULT_QUALITY_CONFIG, validateQualityConfig } from '../../src/lib/admin/vm-quality-config.mjs'
import { applyVmPool, keyAllowsVm, keyScopeFromRecord } from '../../src/lib/admin/key-scope.mjs'

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-quality-groups-'))
  const dbPath = path.join(dir, 'kin.db')
  let db = createDatabase({ dbPath })
  let pools = new VmPoolsRepo(db)
  const original = ['Original A', 'Original B'].map((name) => pools.insert({ name }).id).sort()
  const target = ['Degraded A', 'Degraded B'].map((name) => pools.insert({ name }).id).sort()
  const vm = {
    id: 'vm-quality',
    status: 'running',
    has_token: true,
    platform: 'openai',
    created_at: '2026-10-13T00:00:00Z',
    assignment_id: 'cycle-a',
    email: 'quality@example.test',
    schedulable: true,
    execution_mode: 'docker_per_slot',
    group_ids: original,
  }
  const slots = [vm]
  pools.addToGroups(original, vm.id)
  pools.addToGroups([...original, ...target], 'vm-other')
  let time = 1000000
  let verdict = 'degraded'
  const errors = []
  const start = () =>
    createVmQualityMonitor({
      db,
      listTargets: () => slots,
      now: () => time,
      changeSchedule: () => assert.fail('group mode must never change the scheduling switch'),
      onError: (_, error) => errors.push(error),
      runProbe:
        options.runProbe ||
        (async ({ question }) => ({
          ok: verdict !== 'error',
          complete: true,
          text: verdict === 'normal' ? question.answer : 'wrong',
          duration_ms: 10,
        })),
    })
  let monitor = start()
  t.after(() => {
    monitor.stop()
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const config = (patch = {}) =>
    monitor.setConfig({
      ...monitor.getConfig(),
      switch_groups_on_degraded: true,
      degraded_group_ids: target,
      failure_limit: 2,
      recovery_limit: 2,
      ...patch,
    })
  config()
  return {
    vm,
    slots,
    original,
    target,
    errors,
    config,
    get db() {
      return db
    },
    get pools() {
      return pools
    },
    get monitor() {
      return monitor
    },
    groups: () =>
      pools
        .list()
        .filter((group) => group.vm_ids.includes(vm.id))
        .map((group) => group.id)
        .sort(),
    snapshot: () => monitor.history(vm.id),
    async run(status = 'degraded', source = 'manual') {
      verdict = status
      if (source === 'auto') {
        time += 86400000
        monitor.tick()
      } else monitor.enqueue(vm.id)
      await monitor.idle()
    },
    restart() {
      monitor.stop()
      db.close()
      db = createDatabase({ dbPath })
      pools = new VmPoolsRepo(db)
      monitor = start()
    },
  }
}

test('switch to multiple groups and restore the exact originals across database restart, without runtime writes', async (t) => {
  const f = fixture(t)
  const before = structuredClone(f.vm)
  f.monitor.setEnabled([f.vm.id], true)
  await f.run('degraded', 'auto')
  await f.run('error')
  assert.equal(f.snapshot().failure_streak, 1)
  assert.deepEqual(f.groups(), f.original)
  f.restart()
  await f.run('degraded')
  assert.deepEqual(f.groups(), f.target)
  assert.equal(f.snapshot().groups_switched_by_quality, true)
  const allows = (id) =>
    keyAllowsVm(
      applyVmPool(keyScopeFromRecord({ vm_pool_id: id }), (id) => f.pools.get(id)),
      f.vm,
    )
  assert.ok(
    f.original.every((id) => !allows(id)),
    'original group keys stop selecting the moved account',
  )
  assert.ok(f.target.every(allows))
  assert.equal(keyAllowsVm(keyScopeFromRecord(null), f.vm), true, 'global key scope is unchanged')
  await f.run('degraded')
  f.restart()
  await f.run('normal', 'auto')
  await f.run('error')
  assert.equal(f.snapshot().recovery_streak, 1)
  assert.deepEqual(f.groups(), f.target)
  await f.run('normal')
  assert.deepEqual(f.groups(), f.original, 'repeated red results must not overwrite the originals')
  assert.ok(f.original.every(allows))
  assert.ok(f.target.every((id) => !allows(id)))
  assert.equal(f.snapshot().groups_switched_by_quality, false)
  assert.deepEqual(f.vm, before, 'retain onboarding groups, kernel, schedule and identity fields')
  assert.ok(f.pools.list().every((group) => group.vm_ids.includes('vm-other')))
  assert.deepEqual(f.errors, [])
})

test('no original groups is a real saved state and restores to no groups', async (t) => {
  const f = fixture(t)
  for (const id of f.original) f.pools.setMembers(id, ['vm-other'])
  f.config({ failure_limit: 1, recovery_limit: 1 })
  await f.run()
  assert.deepEqual(f.groups(), f.target)
  f.restart()
  await f.run('normal')
  assert.deepEqual(f.groups(), [])
  assert.equal(f.snapshot().groups_switched_by_quality, false)
})

test('opposite results break streaks; manual pause and all VM runtime kinds retain their state', async (t) => {
  for (const execution_mode of ['docker_per_slot', 'kvm_per_slot']) {
    const f = fixture(t)
    Object.assign(f.vm, { execution_mode, schedulable: false, schedule_disabled_reason: 'manual' })
    const before = structuredClone(f.vm)
    await f.run()
    await f.run('normal')
    await f.run()
    assert.deepEqual(f.groups(), f.original)
    await f.run()
    await f.run('normal')
    await f.run()
    await f.run('normal')
    assert.deepEqual(f.groups(), f.target)
    await f.run('normal')
    assert.deepEqual(f.groups(), f.original)
    assert.deepEqual(f.vm, before)
  }
})

test('changing targets retains the first backup; disabling new moves still permits recovery', async (t) => {
  const f = fixture(t)
  f.config({ failure_limit: 1, recovery_limit: 1 })
  await f.run()
  const third = f.pools.insert({ name: 'New target' }).id
  f.config({ degraded_group_ids: [third], failure_limit: 1, recovery_limit: 1 })
  await f.run()
  assert.deepEqual(f.groups(), [third])
  f.config({ switch_groups_on_degraded: false, recovery_limit: 1 })
  f.restart()
  await f.run('normal')
  assert.deepEqual(f.groups(), f.original)
  await f.run()
  await f.run()
  assert.deepEqual(f.groups(), f.original)
})

test('disabled automatic detection does not act; a manual recovery still restores', async (t) => {
  const f = fixture(t)
  f.config({ failure_limit: 1, recovery_limit: 1 })
  await f.run('degraded', 'auto')
  assert.deepEqual(f.groups(), f.original)
  await f.run()
  await f.run('normal', 'auto')
  assert.deepEqual(f.groups(), f.target)
  await f.run('normal')
  assert.deepEqual(f.groups(), f.original)
})

test('operator membership edits cancel old recovery, including remove and re-add to the same group', async (t) => {
  const f = fixture(t)
  f.config({ failure_limit: 1, recovery_limit: 1 })
  await f.run()
  f.pools.setMembers(f.target[0], ['vm-other'])
  f.pools.addMember(f.target[0], f.vm.id)
  f.restart()
  await f.run('normal')
  assert.deepEqual(f.groups(), f.target)
  assert.equal(f.snapshot().groups_switched_by_quality, false)
  const extra = f.pools.insert({ name: 'Manual' }).id
  f.pools.addMember(extra, f.vm.id)
  await f.run('normal')
  assert.deepEqual(f.groups(), [...f.target, extra].sort())
})

test('late probes cannot override group/config/schedule edits, account replacement or disabled auto checks', async (t) => {
  for (const edit of ['membership', 'config', 'schedule', 'identity', 'off']) {
    await t.test(edit, async (t) => {
      let finish
      const f = fixture(t, {
        runProbe: () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      })
      f.config({ failure_limit: 1 })
      f.monitor.setEnabled([f.vm.id], true)
      f.monitor.tick()
      await new Promise((resolve) => queueMicrotask(resolve))
      if (edit === 'membership') {
        f.pools.setMembers(f.original[0], ['vm-other'])
        f.pools.addMember(f.original[0], f.vm.id)
      }
      if (edit === 'config') f.config({ model: 'another-model' })
      if (edit === 'schedule') f.vm.schedule_revision = 'manual-edit'
      if (edit === 'identity') f.vm.assignment_id = 'cycle-b'
      if (edit === 'off') f.monitor.setEnabled([f.vm.id], false)
      finish({ ok: true, complete: true, text: 'wrong', duration_ms: 10 })
      await f.monitor.idle()
      assert.deepEqual(f.groups(), f.original)
      assert.equal(f.snapshot().failure_streak, 0)
    })
  }
})

test('editing other accounts in a shared group preserves this account recovery and streaks', async (t) => {
  const f = fixture(t)
  f.config({ failure_limit: 1 })
  await f.run()
  await f.run('normal')
  f.pools.setMembers(f.target[0], [f.vm.id, 'vm-added'])
  f.pools.rename(f.target[1], 'Renamed degraded group')
  assert.equal(f.snapshot().groups_switched_by_quality, true)
  assert.equal(f.snapshot().recovery_streak, 1)
  await f.run('normal')
  assert.deepEqual(f.groups(), f.original)
  assert.deepEqual(f.pools.get(f.target[0]).vm_ids, ['vm-added'])
})

test('an account already in every target group needs no restore and a fresh config still remembers its originals', async (t) => {
  const f = fixture(t)
  f.config({ degraded_group_ids: f.original, failure_limit: 1, recovery_limit: 1 })
  await f.run()
  assert.deepEqual(f.groups(), f.original)
  assert.equal(f.snapshot().groups_switched_by_quality, false)
  f.config({ failure_limit: 1, recovery_limit: 1 })
  await f.run()
  await f.run('normal')
  assert.deepEqual(f.groups(), f.original)
})

test('reset/replacement never inherits old groups to restore; deleted slots lose recovery state', async (t) => {
  const f = fixture(t)
  f.config({ failure_limit: 1, recovery_limit: 1 })
  await f.run()
  f.vm.assignment_id = 'replacement'
  await f.run('normal')
  assert.deepEqual(f.groups(), f.target)
  assert.equal(f.snapshot().groups_switched_by_quality, false)
  f.slots.length = 0
  f.monitor.tick()
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM vm_quality_state').get().n, 0)
})

test('stopped/deleting or credential-less slots do not change memberships even after a manual probe', async (t) => {
  for (const patch of [{ status: 'stopped' }, { status: 'deleting' }, { has_token: false }]) {
    const f = fixture(t)
    f.config({ failure_limit: 1, recovery_limit: 1 })
    await f.run()
    Object.assign(f.vm, patch)
    await f.run('normal')
    assert.deepEqual(f.groups(), f.target)
  }
})

test('invalid/mutually exclusive configurations are rejected without changing persisted settings', (t) => {
  const f = fixture(t)
  const before = f.monitor.getConfig()
  for (const patch of [
    { pause_on_degraded: true },
    { switch_groups_on_degraded: 'true' },
    { degraded_group_ids: [] },
    { degraded_group_ids: 'bad' },
    { degraded_group_ids: ['bad'] },
    { degraded_group_ids: ['pool_ffffffff'] },
  ])
    assert.throws(() => f.monitor.setConfig({ ...before, ...patch }))
  f.pools.setEnabled(f.target[0], false)
  assert.throws(() => f.monitor.setConfig(before), /未启用/)
  assert.deepEqual(f.monitor.getConfig(), before)
  const { switch_groups_on_degraded, degraded_group_ids, ...legacy } = DEFAULT_QUALITY_CONFIG
  assert.equal(validateQualityConfig(legacy).switch_groups_on_degraded, false)
  assert.deepEqual(validateQualityConfig(legacy).degraded_group_ids, [])
})

test('all-account detection toggles remain usable when a configured group becomes unavailable', (t) => {
  const f = fixture(t)
  f.monitor.setEnabled([], true, true)
  f.pools.setEnabled(f.target[0], false)
  f.pools.remove(f.target[1])
  assert.equal(f.monitor.setEnabled([], false, true).count, 1)
  assert.equal(f.monitor.getConfig().default_enabled, false)
  assert.equal(f.snapshot().enabled, false)
  f.restart()
  assert.equal(f.monitor.getConfig().default_enabled, false)
  assert.equal(f.monitor.setEnabled([], true, true).count, 1)
  assert.equal(f.snapshot().enabled, true)
})

test('target becoming unavailable prevents all changes and retries after repair', async (t) => {
  const f = fixture(t)
  f.config({ failure_limit: 1, recovery_limit: 1 })
  f.pools.setEnabled(f.target[1], false)
  await f.run()
  assert.deepEqual(f.groups(), f.original)
  assert.match(f.snapshot().group_action_error, /未启用/)
  assert.equal(f.snapshot().groups_switched_by_quality, false)
  f.pools.setEnabled(f.target[1], true)
  await f.run()
  assert.deepEqual(f.groups(), f.target)
  assert.equal(f.snapshot().group_action_error, null)
})

test('restoring disabled originals preserves their disabled status; missing originals keep the backup and surface errors', async (t) => {
  const f = fixture(t)
  f.config({ failure_limit: 1, recovery_limit: 1 })
  await f.run()
  f.pools.setEnabled(f.original[0], false)
  await f.run('normal')
  assert.deepEqual(f.groups(), f.original)
  assert.equal(f.pools.get(f.original[0]).enabled, false)
  await f.run()
  f.pools.remove(f.original[1])
  await f.run('normal')
  assert.deepEqual(f.groups(), f.target, 'no partial restore if any original group is missing')
  assert.equal(f.snapshot().groups_switched_by_quality, true)
  assert.match(f.snapshot().group_action_error, /已删除/)
  // An explicit membership edit resolves the pending restore without widening key scopes.
  f.pools.setMembers(f.target[0], ['vm-other'])
  assert.equal(f.snapshot().groups_switched_by_quality, false)
  assert.equal(f.snapshot().group_action_error, null)
})

test('a database write failure rolls back membership, original backup and version together', async (t) => {
  const f = fixture(t)
  f.config({ failure_limit: 1, recovery_limit: 1 })
  f.db.exec(`CREATE TRIGGER fail_quality_test BEFORE INSERT ON vm_pool_members
    WHEN NEW.pool_id = '${f.target[1]}' AND NEW.vm_id = '${f.vm.id}'
    BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;`)
  await f.run()
  assert.deepEqual(f.groups(), f.original)
  assert.equal(f.snapshot().groups_switched_by_quality, false)
  assert.match(f.snapshot().group_action_error, /injected storage failure/)
  f.db.exec('DROP TRIGGER fail_quality_test')
  await f.run()
  await f.run('normal')
  assert.deepEqual(f.groups(), f.original)
  assert.equal(f.snapshot().group_action_error, null)
})
