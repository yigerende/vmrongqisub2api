import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { startGateway, api, TEST_API_KEY } from '../harness.mjs'

test('real gateway defaults unlimited, hot applies isolated limits and persists through restart', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-request-limits-'))
  fs.mkdirSync(path.join(project, 'vms'))
  fs.writeFileSync(path.join(project, 'vms', 'active.json'), JSON.stringify({ active_vm: null }))
  let gateway
  const stop = async () => {
    if (!gateway) return
    const exited =
      gateway.child.exitCode == null && gateway.child.signalCode == null
        ? once(gateway.child, 'exit')
        : Promise.resolve()
    await gateway.stop()
    await exited
  }
  t.after(async () => {
    await stop()
    fs.rmSync(project, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  const options = {
    project,
    env: {
      VM2API_API_KEY: TEST_API_KEY,
      VM2API_ADMIN_PASSWORD: 'testpass',
      VM2API_DB_SECRET: 'request-limits-startup-test-secret-32-characters',
      KIN_DB_PATH: path.join(project, 'data', 'kin.db'),
      KIN_BACKUP_DISABLED: '1',
      KIN_RATE_ENABLED: '',
      KIN_RATE_CAP: '',
      KIN_RATE_REFILL: '',
      KIN_PANEL_RATE_ENABLED: '',
      KIN_PANEL_RATE_CAP: '',
      KIN_PANEL_RATE_REFILL: '',
    },
  }
  gateway = await startGateway(options)
  const endpoint = '/api/panel/request-limits'
  const get = () => api(gateway, 'GET', endpoint)
  const save = (body, headers) => api(gateway, 'PUT', endpoint, { body, headers })
  const initial = await get()
  assert.equal(initial.status, 200, initial.text)
  assert.equal(initial.json.data.api.enabled, false)
  assert.equal(initial.json.data.panel.enabled, false)
  // Empty fleet: local model catalog reads, no Docker or upstream model calls.
  for (const url of ['/v1/models', '/api/panel/me']) {
    const responses = await Promise.all(Array.from({ length: 70 }, () => api(gateway, 'GET', url)))
    for (const response of responses) assert.equal(response.status, 200, response.text)
  }
  const login = await api(gateway, 'POST', '/api/panel/login', { body: { username: 'admin', password: 'testpass' } })
  assert.equal(login.status, 200, login.text)
  const session = { authorization: `Bearer ${login.json.token}` }
  const rate = { enabled: true, rpm: 0.001, burst: 2 }
  assert.equal((await save({ api: rate }, session)).status, 200)
  assert.equal((await api(gateway, 'GET', '/v1/models')).status, 200)
  assert.equal((await api(gateway, 'GET', '/v1/models')).status, 200)
  const limited = await api(gateway, 'GET', '/v1/models')
  assert.equal(limited.status, 429, limited.text)
  assert.equal(limited.json.error.code, 'gateway_rate_limit')
  assert.equal((await get()).status, 200, 'the same master key can still administer')
  assert.equal((await save({ api: { ...rate, enabled: false }, panel: rate }, session)).status, 200)
  // The API bucket and panel session bucket are separate, as are panel users and master keys.
  assert.equal((await api(gateway, 'GET', '/v1/models')).status, 200)
  for (let i = 0; i < 2; i++)
    assert.equal((await api(gateway, 'GET', '/api/panel/me', { headers: session })).status, 200)
  const panelLimited = await api(gateway, 'GET', '/api/panel/me', { headers: session })
  assert.equal(panelLimited.status, 429, panelLimited.text)
  assert.equal(panelLimited.json.error.code, 'gateway_rate_limit')
  assert.equal((await save({ panel: { ...rate, enabled: false } })).status, 200)
  assert.equal((await api(gateway, 'GET', '/api/panel/me', { headers: session })).status, 200)
  const invalid = await save({ api: { ...rate, burst: -1 } })
  assert.equal(invalid.status, 400, invalid.text)
  for (const role of ['user', 'super']) {
    const username = `limits-${role}`
    const created = await api(gateway, 'POST', '/api/panel/users', {
      body: { username, password: 'fixture-password', role },
    })
    assert.equal(created.status, 201, created.text)
    const signedIn = await api(gateway, 'POST', '/api/panel/login', {
      body: { username, password: 'fixture-password' },
    })
    assert.equal(signedIn.status, 200, signedIn.text)
    for (const method of ['GET', 'PUT']) {
      const forbidden = await api(gateway, method, endpoint, {
        headers: { authorization: `Bearer ${signedIn.json.token}` },
        ...(method === 'PUT' ? { body: { api: rate } } : {}),
      })
      assert.equal(forbidden.status, 403, forbidden.text)
    }
  }
  const key = await api(gateway, 'POST', '/api/panel/api-keys', {
    body: { name: 'rate-test', group_type: 'all', rpm: 0 },
  })
  assert.equal(key.status, 201, key.text)
  const client = { authorization: `Bearer ${key.json.item.key}` }
  for (const method of ['GET', 'PUT']) {
    const response = await api(gateway, method, endpoint, {
      headers: client,
      ...(method === 'PUT' ? { body: { api: rate } } : {}),
    })
    assert.equal(response.status, 403, response.text)
  }
  assert.equal((await save({ api: rate })).status, 200)
  // Master and managed key receive independent API buckets.
  for (const headers of [undefined, client]) {
    for (let i = 0; i < 2; i++) assert.equal((await api(gateway, 'GET', '/v1/models', { headers })).status, 200)
    assert.equal((await api(gateway, 'GET', '/v1/models', { headers })).status, 429)
  }
  const beforeRestart = (await get()).json.data
  await stop()
  gateway = await startGateway(options)
  assert.deepEqual((await get()).json.data, beforeRestart)
  for (let i = 0; i < 2; i++) assert.equal((await api(gateway, 'GET', '/v1/models')).status, 200)
  assert.equal((await api(gateway, 'GET', '/v1/models')).status, 429)
  assert.equal((await save({ api: null, panel: null })).status, 200)
  assert.deepEqual((await get()).json.data, initial.json.data)
  assert.equal((await api(gateway, 'GET', '/v1/models')).status, 200)
})
