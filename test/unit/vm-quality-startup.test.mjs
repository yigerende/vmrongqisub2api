import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startGateway, api, TEST_API_KEY } from '../harness.mjs'

test('real control plane starts with quality monitor and restores saved config after restart', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-quality-start-'))
  fs.mkdirSync(path.join(project, 'vms'))
  // Empty fleet: no workers, Docker operations, credentials, or upstream requests.
  fs.writeFileSync(path.join(project, 'vms', 'active.json'), JSON.stringify({ active_vm: null }))
  let gateway
  t.after(async () => {
    await gateway?.stop()
    fs.rmSync(project, { recursive: true, force: true })
  })
  const options = {
    project,
    env: {
      VM2API_API_KEY: TEST_API_KEY,
      VM2API_ADMIN_PASSWORD: 'testpass',
      VM2API_DB_SECRET: 'quality-startup-test-secret-32-characters',
      KIN_DB_PATH: path.join(project, 'data', 'kin.db'),
      KIN_BACKUP_DISABLED: '1',
    },
  }
  gateway = await startGateway(options)
  const capabilities = await api(gateway, 'GET', '/api/panel/space-capabilities')
  assert.equal(capabilities.status, 200, capabilities.text)
  assert.equal(capabilities.json.data.docker_per_slot, true)
  assert.equal(capabilities.json.data.quality_results, true)
  const onboarding = await api(gateway, 'GET', '/api/panel/onboarding')
  assert.equal(onboarding.status, 200, onboarding.text)
  assert.equal(onboarding.json.data.role, 'admin')
  assert.ok(onboarding.json.data.steps.some((step) => step.id === 'slot_account'))
  const dismissed = await api(gateway, 'PUT', '/api/panel/onboarding', { body: { action: 'dismiss' } })
  assert.equal(dismissed.status, 200, dismissed.text)
  assert.equal(dismissed.json.data.status, 'dismissed')
  const config = await api(gateway, 'GET', '/api/panel/vm-quality/settings')
  assert.equal(config.status, 200, config.text)
  const groups = []
  for (const name of ['Degraded A', 'Degraded B']) {
    const group = await api(gateway, 'POST', '/api/panel/vm-pools', { body: { name } })
    assert.equal(group.status, 201, group.text)
    groups.push(group.json.data.pool.id)
  }
  const next = {
    ...config.json.data,
    interval_seconds: 120,
    mode: 'content',
    switch_groups_on_degraded: true,
    degraded_group_ids: groups,
  }
  const invalid = await api(gateway, 'PUT', '/api/panel/vm-quality/settings', {
    body: { ...next, pause_on_degraded: true },
  })
  assert.equal(invalid.status, 400, invalid.text)
  const saved = await api(gateway, 'PUT', '/api/panel/vm-quality/settings', {
    body: next,
  })
  assert.equal(saved.status, 200, saved.text)
  await gateway.stop()
  gateway = await startGateway(options)
  const onboardingAfterRestart = await api(gateway, 'GET', '/api/panel/onboarding')
  assert.equal(onboardingAfterRestart.status, 200, onboardingAfterRestart.text)
  assert.equal(onboardingAfterRestart.json.data.status, 'dismissed')
  const restored = await api(gateway, 'GET', '/api/panel/vm-quality/settings')
  assert.equal(restored.status, 200, restored.text)
  assert.equal(restored.json.data.interval_seconds, 120)
  assert.equal(restored.json.data.mode, 'content')
  assert.equal(restored.json.data.switch_groups_on_degraded, true)
  assert.deepEqual(restored.json.data.degraded_group_ids, groups.sort())
  const list = await api(gateway, 'GET', '/api/panel/vms')
  assert.equal(list.status, 200, list.text)
  assert.deepEqual(list.json.data.items, [])
})
