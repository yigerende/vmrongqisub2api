import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { startGateway, api } from '../harness.mjs'
import { fakeStreamKernel } from '../helpers/fake-stream-kernel.mjs'

async function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-runtime-test-'))
  const kernel = await fakeStreamKernel(root, options)
  const id = 'vm-runtime'
  fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      platform: 'openai',
      family: 'codex',
      status: 'running',
      schedulable: true,
      policy: { maxConcurrency: 20, concurrencyOverride: true },
      proxy: { id: 'local', kind: 'local', scheme: 'local' },
      runtime: { codex_kernel_socket: kernel.socketPath, worker_token_file: kernel.tokenPath },
    }),
  )
  fs.writeFileSync(
    path.join(root, 'vms', id, 'codex-credentials.json'),
    JSON.stringify({
      accounts: [{ access_token: 'test-access', email: 'runtime@test.invalid' }],
    }),
  )
  fs.writeFileSync(path.join(root, 'vms', 'active.json'), JSON.stringify({ active_vm: id }))
  const gateway = await startGateway({
    project: root,
    readyMs: 30000,
    env: {
      KIN_CRS_MOCK: '0',
      KIN_BACKUP_DISABLED: '1',
      VM2API_STREAM_WORKERS: '2',
      // A health-ready simulated kernel is reused; this executable is never spawned.
      KIN_CODEX_KERNEL_BIN: process.execPath,
    },
  })
  t.after(async () => {
    await gateway.stop()
    if (gateway.child.exitCode == null && gateway.child.signalCode == null) await once(gateway.child, 'exit')
    await kernel.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { gateway, kernel }
}

const body = { model: 'gpt-5.4', input: 'runtime parity test', stream: true }

test('real HTTP entry uses stream workers, reports committed logs and survives backup restore', async (t) => {
  const { gateway, kernel } = await setup(t)
  const health = await api(gateway, 'GET', '/health')
  assert.equal(health.json.stream_runtime.workers, 2)
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      api(gateway, 'POST', '/v1/responses', {
        body,
        headers: { 'x-request-id': `runtime-${i}`, 'x-session-id': `conversation-${i}` },
      }),
    ),
  )
  for (const response of responses) {
    assert.equal(response.status, 200, response.text)
    assert.match(response.text, /response.completed/)
  }
  assert.equal(kernel.stats.started, 12)
  const logs = await api(gateway, 'GET', '/api/panel/request-logs?limit=50')
  assert.equal(logs.status, 200, logs.text)
  assert.equal(logs.json.items.filter((row) => row.request_id.startsWith('runtime-')).length, 12)
  assert.ok(logs.json.items.every((row) => row.cache_read_tokens === 10))
  const backup = await api(gateway, 'POST', '/api/panel/backups')
  assert.equal(backup.status, 201, backup.text)
  const restored = await api(gateway, 'POST', `/api/panel/backups/${backup.json.item.id}/restore`, {
    body: { confirm: true },
  })
  assert.equal(restored.status, 200, restored.text)
  const after = await api(gateway, 'POST', '/v1/responses', { body })
  assert.equal(after.status, 200, after.text)
  assert.match(after.text, /response.completed/)
  const stats = await api(gateway, 'GET', '/api/panel/request-logs/stats')
  assert.equal(stats.status, 200, stats.text)
  const runtime = await api(gateway, 'GET', '/health')
  assert.equal(runtime.json.stream_runtime.active, 0)
})

test('SIGTERM drains an active response before shutting down its workers', {
  skip: process.platform === 'win32',
}, async (t) => {
  const { gateway } = await setup(t, { chunks: 30, intervalMs: 20 })
  const response = await fetch(gateway.baseUrl + '/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${gateway.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200)
  const exit = once(gateway.child, 'exit')
  gateway.child.kill('SIGTERM')
  assert.match(await response.text(), /response.completed/)
  assert.equal((await exit)[0], 0)
})
