/**
 * Named slot pools. Membership is the schedule source for keys with vm_pool_id.
 * Account groups are many-to-many; legacy pool IDs and key scopes are preserved.
 */
import crypto from 'node:crypto'
import { getDb, withTransaction } from '../database.mjs'

function nowIso() {
  return new Date().toISOString()
}

function rowToPool(row, vmIds) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    vm_ids: vmIds,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export class VmPoolsRepo {
  constructor(db = getDb()) {
    this.db = db
    this._list = db.prepare('SELECT * FROM vm_pools ORDER BY created_at, id')
    this._get = db.prepare('SELECT * FROM vm_pools WHERE id = ?')
    this._members = db.prepare('SELECT vm_id FROM vm_pool_members WHERE pool_id = ? ORDER BY vm_id')
    this._allMembers = db.prepare('SELECT pool_id, vm_id FROM vm_pool_members ORDER BY vm_id')
    this._insert = db.prepare('INSERT INTO vm_pools (id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    this._name = db.prepare('UPDATE vm_pools SET name = ?, updated_at = ? WHERE id = ?')
    this._enabled = db.prepare('UPDATE vm_pools SET enabled = ?, updated_at = ? WHERE id = ?')
    this._touch = db.prepare('UPDATE vm_pools SET updated_at = ? WHERE id = ?')
    this._delete = db.prepare('DELETE FROM vm_pools WHERE id = ?')
    this._addMember = db.prepare('INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES (?, ?, ?)')
    this._keyCount = db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE vm_pool_id = ? AND deleted_at IS NULL')
  }

  _ids(poolId) {
    return this._members.all(poolId).map((row) => row.vm_id)
  }

  list() {
    const grouped = new Map()
    for (const row of this._allMembers.all()) {
      const list = grouped.get(row.pool_id) || []
      list.push(row.vm_id)
      grouped.set(row.pool_id, list)
    }
    return this._list.all().map((row) => rowToPool(row, grouped.get(row.id) || []))
  }

  get(id) {
    const row = this._get.get(id)
    if (!row) return null
    return rowToPool(row, this._ids(id))
  }

  countKeys(id) {
    return Number(this._keyCount.get(id)?.n) || 0
  }

  insert({ name, enabled = true }) {
    const now = nowIso()
    const id = `pool_${crypto.randomBytes(4).toString('hex')}`
    try {
      this._insert.run(id, name, enabled ? 1 : 0, now, now)
    } catch (error) {
      throw mapConstraint(error)
    }
    return this.get(id)
  }

  rename(id, name) {
    try {
      const info = this._name.run(name, nowIso(), id)
      if (!info.changes) return null
    } catch (error) {
      throw mapConstraint(error)
    }
    return this.get(id)
  }

  setEnabled(id, enabled) {
    const info = this._enabled.run(enabled ? 1 : 0, nowIso(), id)
    if (!info.changes) return null
    return this.get(id)
  }

  /**
   * Replace this group's membership without touching any other group.
   */
  setMembers(id, vmIds) {
    if (!this._get.get(id)) return null
    const now = nowIso()
    withTransaction(this.db, () => {
      // Preserve unchanged memberships and their quality recovery ownership.
      const previous = new Set(this._ids(id))
      const next = new Set(vmIds)
      const remove = this.db.prepare('DELETE FROM vm_pool_members WHERE pool_id = ? AND vm_id = ?')
      for (const vmId of previous) if (!next.has(vmId)) remove.run(id, vmId)
      for (const vmId of next) if (!previous.has(vmId)) this._addMember.run(id, vmId, now)
      this._touch.run(now, id)
    })
    return this.get(id)
  }

  addMember(id, vmId) {
    this.addToGroups([id], vmId)
    return this.get(id)
  }

  assertEnabled(ids) {
    for (const id of ids) {
      if (!this._get.get(id)?.enabled) {
        throw Object.assign(new Error(`账号分组 ${id} 不存在或未启用`), { code: 'pool_unavailable', status: 400 })
      }
    }
  }

  /** All requested groups succeed together; no partial/global fallback. */
  addToGroups(ids, vmId) {
    withTransaction(this.db, () => {
      this.assertEnabled(ids)
      const insert = this.db.prepare(
        'INSERT OR IGNORE INTO vm_pool_members (pool_id, vm_id, created_at) VALUES (?, ?, ?)',
      )
      const now = nowIso()
      for (const id of new Set(ids)) insert.run(id, vmId, now)
    })
  }

  remove(id) {
    const info = this._delete.run(id)
    return info.changes > 0
  }
}

function mapConstraint(error) {
  const message = String(error?.message || error)
  if (/UNIQUE/i.test(message) && /vm_pools|name/i.test(message)) {
    return Object.assign(new Error('账号池名称已存在'), { code: 'vm_pool_name_taken' })
  }
  return error
}
