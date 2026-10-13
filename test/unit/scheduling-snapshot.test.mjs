import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWriteJson } from '../../src/lib/vm/vm-file.mjs'
import { getVm, listVms } from '../../src/lib/vm/vm-registry.mjs'
import { writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { startSchedulingSnapshot, stopSchedulingSnapshots } from '../../src/lib/vm/scheduling-snapshot.mjs'
import { handleCodexProtocol, pickCodexCandidates } from '../../src/lib/protocol/handle-codex.mjs'
import { resetOpenAIAccountRuntime } from '../../src/lib/pool/openai-account-runtime.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-snapshot-'))
  for (const id of ['vm-a', 'vm-b']) {
    fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
    atomicWriteJson(path.join(root, 'vms', `${id}.json`), {
      id,
      platform: 'openai',
      family: 'codex',
      execution_mode: 'docker_per_slot',
      status: 'running',
      schedulable: true,
      proxy: { kind: 'local', id: 'local' },
    })
    writeCodexAccounts(root, id, [{ access_token: 'test-at', email: `${id}@test.invalid` }])
  }
  t.after(() => {
    stopSchedulingSnapshots()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

test('cached records preserve candidate order and immediately reflect internal edits and credentials', (t) => {
  const root = fixture(t)
  const req = { headers: {}, apiKeyKind: 'master' }
  const before = pickCodexCandidates(root, req)
  const snapshot = startSchedulingSnapshot(root)
  resetOpenAIAccountRuntime()
  assert.deepEqual(pickCodexCandidates(root, req), before)
  assert.deepEqual(
    snapshot.list({}),
    listVms(root).filter((vm) => vm.platform === 'openai'),
  )
  const file = path.join(root, 'vms', 'vm-a.json')
  atomicWriteJson(file, { ...getVm(root, 'vm-a'), schedulable: false, schedule_manual: true })
  assert.deepEqual(pickCodexCandidates(root, req).ids, ['vm-b'])
  // Existing master probes intentionally remain usable for a paused account.
  assert.deepEqual(pickCodexCandidates(root, { ...req, headers: { 'x-kin-vm': 'vm-a' } }).ids, ['vm-a'])
  writeCodexAccounts(root, 'vm-b', [])
  assert.equal(pickCodexCandidates(root, req).ids.length, 0)
  writeCodexAccounts(root, 'vm-b', [{ access_token: 'new-at' }])
  assert.deepEqual(pickCodexCandidates(root, req).ids, ['vm-b'])
  assert.equal(snapshot.list({ codex: { quota: { max_concurrency: 37 } } })[1].max_concurrency, 37)
})

test('external deletion or pause is checked again before acquiring a cached candidate', async (t) => {
  const root = fixture(t)
  const snapshot = startSchedulingSnapshot(root)
  snapshot.list({})
  fs.unlinkSync(path.join(root, 'vms', 'vm-a.json'))
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-b.json'),
    JSON.stringify({
      ...getVm(root, 'vm-b'),
      schedulable: false,
      schedule_manual: true,
    }),
  )
  let response
  await handleCodexProtocol({
    req: { headers: {}, apiKeyKind: 'master' },
    res: {},
    protocol: 'openai.responses',
    ctx: { body: { model: 'gpt-5.4', input: 'hello' } },
    inbound: {},
    logBag: {},
    stats: { errors: 0, requests: 0, by_route: {} },
    routing: {},
    projectRoot: root,
    json: (_res, status, body) => {
      response = { status, body }
    },
    writeSSEHeaders: () => assert.fail('stale account cannot stream'),
    ops: { ensureCodexKernel: () => assert.fail('stale account cannot start a kernel') },
  })
  assert.equal(response.status, 503)
  assert.equal(snapshot.records.has('vm-a'), false)
})
