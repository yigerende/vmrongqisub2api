import { getDb, withTransaction } from '../database.mjs'

export class VmQualityRepo {
  constructor(db = getDb()) {
    this.db = db
  }

  get(id) {
    return this.db.prepare('SELECT * FROM vm_quality_state WHERE vm_id = ?').get(id) || null
  }

  ensure(id, identity, enabled) {
    const previous = this.get(id)
    if (previous?.identity === identity) return previous
    return withTransaction(this.db, () => {
      this.remove(id)
      this.db
        .prepare('INSERT INTO vm_quality_state(vm_id, identity, enabled) VALUES (?, ?, ?)')
        .run(id, identity, Number(previous ? !!previous.enabled : enabled))
      return this.get(id)
    })
  }

  remove(id) {
    this.db.prepare('DELETE FROM vm_quality_state WHERE vm_id = ?').run(id)
  }

  ids() {
    return this.db
      .prepare('SELECT vm_id FROM vm_quality_state')
      .all()
      .map((row) => row.vm_id)
  }

  enable(id, enabled) {
    this.db.prepare('UPDATE vm_quality_state SET enabled = ?, next_at = 0 WHERE vm_id = ?').run(Number(enabled), id)
  }

  reschedule() {
    this.db.prepare('UPDATE vm_quality_state SET next_at = 0, question_cursor = 0').run()
  }

  history(id, limit = 16) {
    return this.db
      .prepare('SELECT id, payload FROM vm_quality_history WHERE vm_id = ? ORDER BY id DESC LIMIT ?')
      .all(id, limit)
      .map((row) => ({ ...JSON.parse(row.payload), id: row.id }))
      .reverse()
  }

  record(id, identity, result, nextAt, cursor, limit) {
    if (this.get(id)?.identity !== identity) return false
    return withTransaction(this.db, () => {
      this.db.prepare('INSERT INTO vm_quality_history(vm_id, payload) VALUES (?, ?)').run(id, JSON.stringify(result))
      this.db
        .prepare('UPDATE vm_quality_state SET next_at = ?, question_cursor = ? WHERE vm_id = ?')
        .run(nextAt, cursor, id)
      this.trim(id, limit)
      return true
    })
  }

  trim(id, limit) {
    this.db
      .prepare(`DELETE FROM vm_quality_history WHERE vm_id = ? AND id NOT IN
      (SELECT id FROM vm_quality_history WHERE vm_id = ? ORDER BY id DESC LIMIT ?)`)
      .run(id, id, limit)
  }
}
