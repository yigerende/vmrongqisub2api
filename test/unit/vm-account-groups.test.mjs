import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ApiKeyStore } from '../../src/lib/admin/api-keys.mjs'
import { VmPoolsRepo } from '../../src/lib/db/repos/vm-pools-repo.mjs'
import { applyVmPool, keyScopeFromRecord, keyAllowsVm, keyScopeFromRequest } from '../../src/lib/admin/key-scope.mjs'
import { normalizeVmGroupIds } from '../../src/lib/admin/vm-account-groups.mjs'

test('upgrade preserves original groups, memberships and key binding while allowing overlap', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE api_keys (id TEXT PRIMARY KEY)')
    db.exec(fs.readFileSync(new URL('../../src/lib/db/migrations/034_vm_pools.sql', import.meta.url), 'utf8'))
    db.exec(
      "INSERT INTO vm_pools VALUES ('pool_aaaaaaaa','A',1,'now','now'),('pool_bbbbbbbb','B',1,'now','now'); INSERT INTO vm_pool_members VALUES ('pool_aaaaaaaa','vm-1','now'); INSERT INTO api_keys VALUES ('key','pool_aaaaaaaa')",
    )
    db.exec(fs.readFileSync(new URL('../../src/lib/db/migrations/041_vm_account_groups.sql', import.meta.url), 'utf8'))
    db.exec("INSERT INTO vm_pool_members VALUES ('pool_bbbbbbbb','vm-1','now')")
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vm_pool_members').get().n, 2)
    assert.equal(db.prepare('SELECT vm_pool_id FROM api_keys').get().vm_pool_id, 'pool_aaaaaaaa')
  } finally {
    db.close()
  }
})

test('multi-group assignment is atomic, idempotent and scopes both keys without widening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vm-groups-'))
  const store = new ApiKeyStore({ dataDir: dir })
  try {
    const repo = new VmPoolsRepo(store.db)
    const a = repo.insert({ name: 'A' }),
      b = repo.insert({ name: 'B' })
    assert.throws(() => repo.addToGroups([a.id, 'pool_ffffffff'], 'vm-1'), /不存在/)
    assert.deepEqual(repo.get(a.id).vm_ids, [])
    repo.addToGroups([a.id, b.id, a.id], 'vm-1')
    repo.addToGroups([a.id, b.id], 'vm-1')
    const keys = [a, b].map((g) => store.create({ name: g.name, vm_pool_id: g.id }))
    const scope = (key) => applyVmPool(keyScopeFromRecord(store.getById(key.id)), (id) => repo.get(id))
    for (const key of keys) {
      assert.equal(keyAllowsVm(scope(key), { id: 'vm-1', platform: 'openai' }), true)
      assert.equal(keyAllowsVm(scope(key), { id: 'vm-outside', platform: 'openai' }), false)
    }
    repo.setEnabled(a.id, false)
    assert.equal(keyAllowsVm(scope(keys[0]), { id: 'vm-1' }), false)
    assert.equal(keyAllowsVm(scope(keys[1]), { id: 'vm-1' }), true)
    assert.throws(() => repo.addToGroups([b.id, a.id], 'vm-2'), /未启用/)
    assert.deepEqual(repo.get(b.id).vm_ids, ['vm-1'])
    repo.setMembers(b.id, [])
    assert.equal(keyAllowsVm(scope(keys[1]), { id: 'vm-1' }), false)
    assert.deepEqual(repo.get(a.id).vm_ids, ['vm-1'])
    assert.equal(keyAllowsVm(keyScopeFromRequest({ apiKeyKind: 'master' }), { id: 'vm-outside' }), true)
  } finally {
    store.db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('group IDs preserve legacy pool assignments and reject invalid or conflicting input', () => {
  assert.deepEqual(normalizeVmGroupIds(undefined, 'pool_aaaaaaaa'), ['pool_aaaaaaaa'])
  assert.deepEqual(normalizeVmGroupIds(['pool_bbbbbbbb', ' pool_aaaaaaaa ', 'pool_bbbbbbbb']), [
    'pool_aaaaaaaa',
    'pool_bbbbbbbb',
  ])
  for (const value of ['pool_aaaaaaaa', ['invalid'], [1], Array(101).fill('pool_aaaaaaaa')]) {
    assert.throws(() => normalizeVmGroupIds(value), { code: 'invalid_group_ids' })
  }
  assert.throws(() => normalizeVmGroupIds([], 'pool_aaaaaaaa'), { code: 'invalid_group_ids' })
})
