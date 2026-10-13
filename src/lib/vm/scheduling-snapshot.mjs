import fs from 'node:fs'
import path from 'node:path'
import { getVm, summarizeVm } from './vm-registry.mjs'
import { isCodexVm } from './vm-kind.mjs'
import { isVmRecordFile, listVmRecordFiles, onFileInvalidated } from './vm-file.mjs'

const snapshots = new Map()

/** Versioned source records, never a cached admission decision or runtime count. */
export class SchedulingSnapshot {
  constructor(projectRoot) {
    this.root = projectRoot
    this.dir = path.join(projectRoot, 'vms')
    this.records = new Map()
    this.dirty = new Set()
    this.membershipDirty = true
    this.unsubscribe = onFileInvalidated((file) => {
      if (!file) return this.invalidateAll()
      const relative = path.relative(this.dir, file)
      if (relative.startsWith('..') || path.isAbsolute(relative)) return
      const parts = relative.split(path.sep)
      if (parts.length === 1 && isVmRecordFile(parts[0])) this.invalidate(parts[0].slice(0, -5))
      else if (parts.length === 2 && parts[1] === 'codex-credentials.json') this.invalidate(parts[0])
    })
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (_event, name) => {
        if (name && isVmRecordFile(String(name))) this.invalidate(String(name).slice(0, -5))
        else this.membershipDirty = true
      })
      this.watcher.on('error', () => this.invalidateAll())
    } catch {}
    // Reconcile external credential writes and missed/coalesced watch events.
    // This scan runs once per interval, never once per request or waiter.
    this.timer = setInterval(() => this.invalidateAll(), 1000)
    this.timer.unref()
  }

  invalidate(id) {
    this.dirty.add(id)
  }

  invalidateAll() {
    this.membershipDirty = true
    for (const id of this.records.keys()) this.dirty.add(id)
  }

  refresh() {
    if (this.membershipDirty) {
      this.membershipDirty = false
      const ids = new Set(listVmRecordFiles(this.dir).map((file) => file.slice(0, -5)))
      for (const id of this.records.keys()) if (!ids.has(id)) this.records.delete(id)
      for (const id of ids) if (!this.records.has(id)) this.dirty.add(id)
    }
    for (const id of this.dirty) {
      try {
        const vm = getVm(this.root, id)
        if (vm && isCodexVm(vm)) this.records.set(id, { vm, summary: null })
        else this.records.delete(id)
      } catch {
        this.records.delete(id)
      }
    }
    this.dirty.clear()
  }

  raw() {
    this.refresh()
    // Quota reconciliation may replace fields on its argument. The source
    // snapshot itself is never exposed for mutation.
    return [...this.records.values()].map(({ vm }) => ({ ...vm, claude: { ...vm.claude } }))
  }

  list(routing) {
    this.refresh()
    const policy = JSON.stringify(routing?.codex?.quota || {})
    return [...this.records.values()].map((entry) => {
      if (!entry.summary || entry.policy !== policy) {
        entry.summary = summarizeVm(entry.vm, this.root, routing)
        entry.policy = policy
      }
      return entry.summary
    })
  }

  close() {
    clearInterval(this.timer)
    this.watcher?.close()
    this.unsubscribe()
  }
}

export function startSchedulingSnapshot(root) {
  const key = path.resolve(root)
  snapshots.get(key)?.close()
  const snapshot = new SchedulingSnapshot(key)
  snapshot.refresh()
  snapshots.set(key, snapshot)
  return snapshot
}

export const schedulingSnapshot = (root) => snapshots.get(path.resolve(root))

export function stopSchedulingSnapshots() {
  for (const snapshot of snapshots.values()) snapshot.close()
  snapshots.clear()
}
