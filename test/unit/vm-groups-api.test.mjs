import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { startGateway, api, TEST_API_KEY } from '../harness.mjs'

test('group management API supports overlap, guarded deletion and management-only discovery', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-groups-api-'))
  const gateway = await startGateway({
    project,
    env: {
      VM2API_API_KEY: TEST_API_KEY,
      VM2API_ADMIN_PASSWORD: 'testpass',
      VM2API_DB_SECRET: 'group-api-test-secret-32-characters',
      KIN_DB_PATH: path.join(project, 'data', 'kin.db'),
      KIN_BACKUP_DISABLED: '1',
    },
  })
  t.after(async () => {
    const exited = gateway.child.exitCode == null ? once(gateway.child, 'exit') : Promise.resolve()
    await gateway.stop()
    await exited
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  const caps = await api(gateway, 'GET', '/api/panel/space-capabilities')
  assert.equal(caps.json.data.account_groups, true)
  const groups = []
  for (const name of ['Team', 'Pro']) {
    const r = await api(gateway, 'POST', '/api/panel/vm-pools', { body: { name, vm_ids: ['vm-sim-01'] } })
    assert.equal(r.status, 201, r.text)
    groups.push(r.json.data.pool)
  }
  const list = await api(gateway, 'GET', '/api/panel/vm-groups')
  assert.equal(list.status, 200, list.text)
  assert.deepEqual(
    list.json.data.groups.map((g) => [g.name, g.account_count]),
    [
      ['Team', 1],
      ['Pro', 1],
    ],
  )
  const key = await api(gateway, 'POST', '/api/panel/api-keys', {
    body: { name: 'team-only', vm_pool_id: groups[0].id },
  })
  assert.equal(key.status, 201, key.text)
  assert.equal((await api(gateway, 'DELETE', `/api/panel/vm-pools/${groups[0].id}`)).status, 409)
  const disabled = await api(gateway, 'PATCH', `/api/panel/vm-pools/${groups[0].id}`, { body: { enabled: false } })
  assert.equal(disabled.status, 200, disabled.text)
  const after = await api(gateway, 'GET', '/api/panel/vm-pools')
  assert.deepEqual(after.json.data.pools.find((g) => g.id === groups[1].id).vm_ids, ['vm-sim-01'])
  const unauth = await api(gateway, 'GET', '/api/panel/vm-groups', { headers: { authorization: 'Bearer invalid' } })
  assert.equal(unauth.status, 401)
  for (const role of ['user', 'super']) {
    const user = await api(gateway, 'POST', '/api/panel/users', {
      body: { username: `groups-${role}`, password: 'test-password', role },
    })
    assert.equal(user.status, 201, user.text)
    const login = await api(gateway, 'POST', '/api/panel/login', {
      body: { username: `groups-${role}`, password: 'test-password' },
    })
    assert.equal(login.status, 200, login.text)
    const denied = await api(gateway, 'GET', '/api/panel/vm-groups', {
      headers: { authorization: `Bearer ${login.json.token}` },
    })
    assert.equal(denied.status, 403, denied.text)
  }
})
