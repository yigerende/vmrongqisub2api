import { withTransaction } from '../db/database.mjs'
import { VmPoolsRepo } from '../db/repos/vm-pools-repo.mjs'

/** Membership changes only: no VM record, scheduling switch, or kernel lifecycle writes. */
export function createQualityGroupActions(db, qualityRepo) {
  const groups = new VmPoolsRepo(db)
  const members = db.prepare('SELECT pool_id FROM vm_pool_members WHERE vm_id = ? ORDER BY pool_id')
  const clear = db.prepare('DELETE FROM vm_pool_members WHERE vm_id = ?')
  const insert = db.prepare('INSERT INTO vm_pool_members (pool_id, vm_id, created_at) VALUES (?, ?, ?)')
  const touch = db.prepare('UPDATE vm_pools SET updated_at = ? WHERE id = ?')
  const save = db.prepare(`UPDATE vm_quality_state SET original_group_ids = ?, switched_group_ids = ?,
    group_action_error = NULL, group_version = membership_version WHERE vm_id = ?`)

  function change(expected, targets, restore = false) {
    return withTransaction(db, () => {
      const state = qualityRepo.get(expected.vm_id)
      if (!state || state.identity !== expected.identity || state.membership_version !== expected.membership_version)
        return false
      const original = state.original_group_ids
      if (restore && original === null) return false
      const ids = restore ? JSON.parse(original) : targets
      if (restore) {
        // A disabled group remains a valid original membership; its keys still fail closed.
        // A deleted group cannot be restored. Keep the backup and report the failure.
        for (const id of ids) if (!groups.get(id)) throw new Error(`原分组 ${id} 已删除，请手动设置账号分组`)
      } else groups.assertEnabled(ids)
      const before = members.all(state.vm_id).map((row) => row.pool_id)
      const after = [...new Set(ids)].sort()
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        const timestamp = new Date().toISOString()
        clear.run(state.vm_id)
        for (const id of after) insert.run(id, state.vm_id, timestamp)
        for (const id of new Set([...before, ...after])) touch.run(timestamp, id)
      } else if (!restore && original === null) {
        qualityRepo.groupError(state.vm_id, null)
        return false
      }
      save.run(
        restore ? null : (original ?? JSON.stringify(before)),
        restore ? null : JSON.stringify(after),
        state.vm_id,
      )
      return true
    })
  }

  return { assertEnabled: (ids) => groups.assertEnabled(ids), change }
}
