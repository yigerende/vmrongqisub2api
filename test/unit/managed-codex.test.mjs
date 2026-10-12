import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { accountContainerName, assertManagedWritable } from '../../src/lib/vm/codex-container.mjs'
import { createManagedCodex, handleManagedCodex } from '../../src/lib/admin/managed-codex.mjs'
import { startVmRuntime, stopVmRuntime, destroyVmRuntime } from '../../src/lib/vm/vm-runtime.mjs'

test('account names are Docker-safe and a new cycle has a unique name', () => {
  const email = 'A+Name@Example.com'
  const a = accountContainerName(email, 'cycle1')
  assert.match(a, /^kin-a-name-example-com-[a-f0-9]{12}$/)
  assert.equal(a, accountContainerName(email, 'cycle1'))
  assert.notEqual(a, accountContainerName(email, 'cycle2'))
})

test('strict slots cannot fall through to legacy Docker lifecycle', () => {
  const vm = { id: 'space-fixture', execution_mode: 'docker_per_slot' }
  for (const fn of [startVmRuntime, stopVmRuntime, destroyVmRuntime]) assert.equal(fn(vm).ok, false)
})

test('deleting an ambiguous create tombstones its assignment and prevents resurrection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'space-tombstone-'))
  const assignment = `space-${crypto.randomBytes(24).toString('hex')}`
  const id = `space-${crypto.createHash('sha256').update(assignment).digest('hex').slice(0, 24)}`
  let response
  const invoke = async (expected = assignment) =>
    handleManagedCodex({
      req: { method: 'DELETE', headers: { 'x-space-assignment': expected } },
      res: {},
      url: new URL(`http://localhost/api/panel/vms/${id}`),
      cfg: { paths: { project: root } },
      json: (_, status, body) => {
        response = { status, body }
        return true
      },
    })
  try {
    await invoke()
    assert.equal(response.status, 200)
    await invoke()
    assert.equal(response.status, 200)
    await invoke('wrong-cycle')
    assert.equal(response.status, 409)
    await assert.rejects(createManagedCodex(root, { assignment_id: assignment }), { code: 'assignment_deleted' })
    assert.throws(() => assertManagedWritable(root, { id, assignment_id: assignment }), { code: 'slot_unavailable' })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
