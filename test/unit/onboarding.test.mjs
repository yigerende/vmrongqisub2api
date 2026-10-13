import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { filterVmsForPanel } from '../../src/lib/admin/resource-owner.mjs'
import {
  DEFAULT_ADMIN_PASSWORD,
  MASTER_ONBOARDING_USER,
  STEPS_BY_ROLE,
  adminPasswordDone,
  applyOnboardingAction,
  buildOnboardingPayload,
  loadOnboardingState,
  needsWelcome,
  onboardingRoleOf,
  onboardingUserOf,
  panelBaseUrl,
  recordOf,
  saveOnboardingState,
  stepsForRole,
  vmStepFacts,
} from '../../src/lib/admin/onboarding.mjs'

function idsOf(role) {
  return stepsForRole(role)
}

function payload(role, facts = {}, extra = {}) {
  return buildOnboardingPayload({ user: extra.user || role, role, facts, ...extra })
}

test('default password is undone only when env is 123456 and admin is absent', () => {
  assert.equal(adminPasswordDone({ envPassword: DEFAULT_ADMIN_PASSWORD, envAdminExists: false }), false)
  assert.equal(adminPasswordDone({ envPassword: '123456', envAdminExists: true }), true)
  assert.equal(adminPasswordDone({ envPassword: 'custom-pass', envAdminExists: false }), true)
  const undone = payload('admin', { envPassword: '123456', envAdminExists: false })
  assert.equal(undone.steps.find((s) => s.id === 'admin_password').done, false)
  const seeded = payload('admin', { envPassword: '123456', envAdminExists: true })
  assert.equal(seeded.steps.find((s) => s.id === 'admin_password').done, true)
  const custom = payload('admin', { envPassword: 'not-default', envAdminExists: false })
  assert.equal(custom.steps.find((s) => s.id === 'admin_password').done, true)
})

test('step sets follow role: admin 6, user 5, super schedulable+first_request', () => {
  assert.deepEqual(idsOf('admin'), [
    'admin_password',
    'egress',
    'slot_account',
    'schedulable',
    'api_key',
    'first_request',
  ])
  assert.equal(STEPS_BY_ROLE.admin.length, 6)
  assert.deepEqual(idsOf('user'), ['egress', 'slot_account', 'schedulable', 'api_key', 'first_request'])
  assert.equal(
    payload('user').steps.some((s) => s.id === 'admin_password'),
    false,
  )
  assert.equal(payload('user').total, 5)
  assert.deepEqual(idsOf('super'), ['schedulable', 'first_request'])
  assert.equal(payload('super').total, 2)
  assert.deepEqual(
    payload('super').steps.map((s) => s.id),
    ['schedulable', 'first_request'],
  )
})

test('needs_welcome is pending and (total=0 or incomplete); all-done skips welcome', () => {
  assert.equal(needsWelcome('pending', 0, 0), true)
  assert.equal(needsWelcome('pending', 0, 6), true)
  assert.equal(needsWelcome('pending', 5, 6), true)
  assert.equal(needsWelcome('pending', 6, 6), false)
  assert.equal(needsWelcome('completed', 0, 6), false)
  assert.equal(needsWelcome('dismissed', 1, 6), false)
  const empty = { ...payload('admin'), steps: [], done_count: 0, total: 0 }
  assert.equal(needsWelcome(empty.status, empty.done_count, empty.total), true)
  const allDone = payload('admin', {
    envPassword: 'custom',
    envAdminExists: false,
    proxyCount: 1,
    vmWithTokenCount: 1,
    schedulableCount: 1,
    activeKeyCount: 1,
    hasFirstRequest: true,
  })
  assert.equal(allDone.done_count, 6)
  assert.equal(allDone.total, 6)
  assert.equal(allDone.needs_welcome, false)
  assert.equal(allDone.status, 'pending')
})

test('PUT complete / dismiss / reset round-trip through settings; invalid action rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-onboarding-'))
  const db = createDatabase({ dataDir: dir })
  const settings = new SettingsRepo(db)
  assert.equal(recordOf(loadOnboardingState(settings), 'admin').status, 'pending')

  saveOnboardingState(settings, applyOnboardingAction(loadOnboardingState(settings), 'admin', 'complete'))
  const completed = recordOf(loadOnboardingState(settings), 'admin')
  assert.equal(completed.status, 'completed')
  assert.ok(completed.updated_at)
  const afterComplete = buildOnboardingPayload({
    user: 'admin',
    role: 'admin',
    ...completed,
    facts: { envPassword: '123456', envAdminExists: false },
  })
  assert.equal(afterComplete.needs_welcome, false)

  saveOnboardingState(settings, applyOnboardingAction(loadOnboardingState(settings), 'admin', 'dismiss'))
  assert.equal(recordOf(loadOnboardingState(settings), 'admin').status, 'dismissed')
  assert.equal(recordOf(loadOnboardingState(settings), 'bob').status, 'pending')

  saveOnboardingState(settings, applyOnboardingAction(loadOnboardingState(settings), 'admin', 'reset'))
  assert.equal(recordOf(loadOnboardingState(settings), 'admin').status, 'pending')
  assert.equal(loadOnboardingState(settings).admin, undefined)

  assert.throws(
    () => applyOnboardingAction({}, 'admin', 'skip'),
    (e) => e.code === 'invalid_action',
  )
  assert.throws(
    () => applyOnboardingAction({}, 'admin', ''),
    (e) => e.code === 'invalid_action',
  )
  assert.throws(
    () => applyOnboardingAction({}, 'admin', undefined),
    (e) => e.code === 'invalid_action',
  )
})

test('only VMs visible to the user drive slot and schedulable steps', () => {
  const vms = [
    { id: 'vm-a', owner_user_id: 'u1', has_token: false, schedulable: true },
    { id: 'vm-b', owner_user_id: 'u2', has_token: true, schedulable: true },
  ]
  const steps = (userId) => payload('user', vmStepFacts(filterVmsForPanel(vms, { role: 'user', userId }))).steps
  assert.equal(steps('u1').find((s) => s.id === 'slot_account').done, false)
  assert.equal(steps('u1').find((s) => s.id === 'schedulable').done, false)
  assert.equal(steps('u2').find((s) => s.id === 'slot_account').done, true)
  assert.equal(steps('u2').find((s) => s.id === 'schedulable').done, true)
})

test('first_request EXISTS uses the same ownerPred as request-log stats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-onboarding-logs-'))
  const db = createDatabase({ dbPath: path.join(dir, 'logs.db') })
  db.exec(`
    INSERT INTO users (id, email, username, password_hash) VALUES ('u1', 'a@x', 'alice', 'x'), ('u2', 'b@x', 'bob', 'x');
    INSERT INTO api_keys (id, name, key, user_id) VALUES ('k1', 'alice-key', 'sk-1', 'u1'), ('k2', 'bob-key', 'sk-2', 'u2');
  `)
  const repo = new UsageLogsRepo(db)
  repo.insertSummary({
    id: 'log_fail',
    request_id: 'req-fail',
    created_at: '2026-01-01T00:00:00.000Z',
    status: 401,
    user_id: 'u1',
  })
  assert.equal(repo.hasSuccessfulRequest({ owner_user_id: 'u1' }), false)
  repo.insertSummary({
    id: 'log_other',
    request_id: 'req-other',
    created_at: '2026-01-01T00:00:01.000Z',
    status: 200,
    user_id: 'u2',
  })
  assert.equal(repo.hasSuccessfulRequest({ owner_user_id: 'u1' }), false)
  assert.equal(repo.hasSuccessfulRequest({ owner_user_id: 'u2' }), true)
  repo.insertSummary({
    id: 'log_ok',
    request_id: 'req-ok',
    created_at: '2026-01-01T00:00:02.000Z',
    status: 200,
    user_id: 'u1',
  })
  assert.equal(repo.hasSuccessfulRequest({ owner_user_id: 'u1' }), true)
  assert.equal(repo.hasSuccessfulRequest({}), true)
  repo.insertSummary({
    id: 'log_redirect',
    request_id: 'req-3xx',
    created_at: '2026-01-01T00:00:03.000Z',
    status: 301,
    user_id: 'u3',
  })
  assert.equal(repo.hasSuccessfulRequest({ owner_user_id: 'u3' }), false)
})

test('master API key identity is __master__ / admin; base_url strips trailing slash', () => {
  assert.equal(
    onboardingUserOf({ apiKeyKind: 'master', panelUser: 'master', panelRole: 'admin' }),
    MASTER_ONBOARDING_USER,
  )
  assert.equal(onboardingRoleOf({ apiKeyKind: 'master', panelUser: 'master' }), 'admin')
  assert.equal(onboardingUserOf({ panelUser: 'alice', panelRole: 'user' }), 'alice')
  assert.equal(onboardingRoleOf({ panelUser: 'alice', panelRole: 'user' }), 'user')
  assert.equal(panelBaseUrl('https://host/'), 'https://host')
  assert.equal(panelBaseUrl('https://host'), 'https://host')
  assert.equal(panelBaseUrl(null), null)
  assert.equal(payload('admin', {}, { base_url: 'https://host/' }).base_url, 'https://host')
})
