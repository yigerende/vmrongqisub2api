import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  atomicWriteJson,
  writeJsonIfChanged,
  withVmLock,
  readFileCached,
  invalidateReadCache,
  VM_READ_CACHE_MAX_ENTRIES,
} from '../../src/lib/vm/vm-file.mjs'
import { getVm, listVms } from '../../src/lib/vm/vm-registry.mjs'
import { persistCodexQuotaSnapshot, readCodexAccounts, writeCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { wipeSlotHome } from '../../src/lib/vm/vm-recreate.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vmcache-'))
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  return root
}

function writeVm(root, id, rec = {}) {
  const file = path.join(root, 'vms', `${id}.json`)
  fs.writeFileSync(file, JSON.stringify({ id, name: id, ...rec }))
  return file
}

test('atomicWriteJson writes valid JSON and leaves no temp files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vf-'))
  const p = path.join(dir, 'vm.json')
  atomicWriteJson(p, { a: 1 }, { mode: 0o600 })
  assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1 })
  const leftover = fs.readdirSync(dir).filter((f) => f.includes('.tmp'))
  assert.equal(leftover.length, 0)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('writeJsonIfChanged skips identical content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vf-'))
  const p = path.join(dir, 'vm.json')
  assert.equal(writeJsonIfChanged(p, { a: 1 }), true)
  const m1 = fs.statSync(p).mtimeMs
  assert.equal(writeJsonIfChanged(p, { a: 1 }), false)
  const m2 = fs.statSync(p).mtimeMs
  assert.equal(m1, m2)
  assert.equal(writeJsonIfChanged(p, { a: 2 }), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('withVmLock serializes writers on the same key (no lost update)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vf-'))
  const p = path.join(dir, 'counter.json')
  fs.writeFileSync(p, JSON.stringify({ n: 0 }))
  const bump = () =>
    withVmLock(p, async () => {
      const cur = JSON.parse(fs.readFileSync(p, 'utf8')).n
      await new Promise((r) => setTimeout(r, 5)) // force interleave window
      atomicWriteJson(p, { n: cur + 1 })
    })
  await Promise.all([bump(), bump(), bump(), bump(), bump()])
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).n, 5)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('getVm returns null for missing files and throws on corrupt JSON or I/O', () => {
  const root = makeProject()
  try {
    assert.equal(getVm(root, 'missing'), null)
    fs.writeFileSync(path.join(root, 'vms', 'bad.json'), '{')
    assert.throws(
      () => getVm(root, 'bad'),
      (err) => err instanceof SyntaxError,
    )
    fs.mkdirSync(path.join(root, 'vms', 'isdir.json'))
    assert.throws(
      () => getVm(root, 'isdir'),
      (err) => err && err.code === 'EISDIR',
    )
    writeVm(root, 'ok', { status: 'stopped' })
    assert.equal(getVm(root, 'ok').id, 'ok')
    const listed = listVms(root)
      .map((vm) => vm.id)
      .sort()
    assert.deepEqual(listed, ['ok'])
    assert.equal(persistCodexQuotaSnapshot(root, 'bad', { planType: 'plus' }), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('listVms and readCodexAccounts keep swallowing unreadable files', () => {
  const root = makeProject()
  try {
    writeVm(root, 'ok')
    fs.writeFileSync(path.join(root, 'vms', 'broken.json'), '{')
    fs.mkdirSync(path.join(root, 'vms', 'vm-cred'))
    fs.writeFileSync(path.join(root, 'vms', 'vm-cred', 'codex-credentials.json'), '{')
    assert.deepEqual(
      listVms(root)
        .map((vm) => vm.id)
        .sort(),
      ['ok'],
    )
    assert.deepEqual(readCodexAccounts(root, 'vm-cred'), [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('cached getVm follows atomic rename and external rewrite', () => {
  const root = makeProject()
  try {
    const file = writeVm(root, 'vm-01', { name: 'one' })
    assert.equal(getVm(root, 'vm-01').name, 'one')
    atomicWriteJson(file, { id: 'vm-01', name: 'two' })
    assert.equal(getVm(root, 'vm-01').name, 'two')
    fs.writeFileSync(file, JSON.stringify({ id: 'vm-01', name: 'three' }))
    assert.equal(getVm(root, 'vm-01').name, 'three')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('mutating a parsed vm record does not poison the next read', () => {
  const root = makeProject()
  try {
    writeVm(root, 'vm-01', { name: 'plain' })
    const first = getVm(root, 'vm-01')
    first.name = 'mutated'
    first.extra = { leaked: true }
    assert.equal(getVm(root, 'vm-01').name, 'plain')
    assert.equal(getVm(root, 'vm-01').extra, undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('writeCodexAccounts replacement is visible on the next credential read', () => {
  const root = makeProject()
  try {
    fs.mkdirSync(path.join(root, 'vms', 'vm-01'), { recursive: true })
    writeCodexAccounts(root, 'vm-01', [{ access_token: 'old-secret' }])
    assert.equal(readCodexAccounts(root, 'vm-01')[0].access_token, 'old-secret')
    writeCodexAccounts(root, 'vm-01', [{ access_token: 'new-secret' }])
    assert.equal(readCodexAccounts(root, 'vm-01')[0].access_token, 'new-secret')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('wipeSlotHome drops cached credential text for that slot', () => {
  const root = makeProject()
  try {
    writeVm(root, 'vm-07')
    fs.mkdirSync(path.join(root, 'vms', 'vm-07'), { recursive: true })
    const credPath = path.join(root, 'vms', 'vm-07', 'codex-credentials.json')
    writeCodexAccounts(root, 'vm-07', [{ access_token: 'wipe-me' }])
    assert.equal(readCodexAccounts(root, 'vm-07')[0].access_token, 'wipe-me')
    wipeSlotHome(root, 'vm-07')
    assert.equal(invalidateReadCache(credPath), false)
    assert.deepEqual(readCodexAccounts(root, 'vm-07'), [])
    assert.equal(getVm(root, 'vm-07').id, 'vm-07')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('read cache evicts the oldest path after the fixed bound', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vf-evict-'))
  try {
    invalidateReadCache()
    const files = []
    for (let i = 0; i < VM_READ_CACHE_MAX_ENTRIES + 1; i++) {
      const file = path.join(dir, `f-${i}.json`)
      fs.writeFileSync(file, `"${i}"`)
      files.push(file)
      assert.equal(readFileCached(file), `"${i}"`)
    }
    const orig = fs.readFileSync
    let reads = 0
    fs.readFileSync = function (...args) {
      reads += 1
      return orig.apply(this, args)
    }
    try {
      assert.equal(readFileCached(files[0]), '"0"')
      assert.ok(reads >= 1, 'oldest path must be re-read after eviction')
      const afterOldest = reads
      assert.equal(readFileCached(files[files.length - 1]), `"${VM_READ_CACHE_MAX_ENTRIES}"`)
      assert.equal(reads, afterOldest, 'newest path must still be cached')
    } finally {
      fs.readFileSync = orig
    }
  } finally {
    invalidateReadCache()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('disabled cache still distinguishes missing, corrupt, and I/O', () => {
  const registryHref = pathToFileURL(path.join(REPO_ROOT, 'src/lib/vm/vm-registry.mjs')).href
  const script = `
    import assert from 'node:assert/strict'
    import fs from 'node:fs'
    import os from 'node:os'
    import path from 'node:path'
    import { getVm, listVms } from ${JSON.stringify(registryHref)}
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-vmcache-off-'))
    try {
      fs.mkdirSync(path.join(root, 'vms'))
      assert.equal(getVm(root, 'missing'), null)
      fs.writeFileSync(path.join(root, 'vms', 'bad.json'), '{')
      assert.throws(() => getVm(root, 'bad'), (err) => err instanceof SyntaxError)
      fs.mkdirSync(path.join(root, 'vms', 'isdir.json'))
      assert.throws(() => getVm(root, 'isdir'), (err) => err && err.code === 'EISDIR')
      fs.writeFileSync(path.join(root, 'vms', 'ok.json'), JSON.stringify({ id: 'ok', name: 'ok' }))
      assert.equal(getVm(root, 'ok').id, 'ok')
      fs.writeFileSync(path.join(root, 'vms', 'ok.json'), JSON.stringify({ id: 'ok', name: 'rewritten' }))
      assert.equal(getVm(root, 'ok').name, 'rewritten')
      assert.deepEqual(listVms(root).map((vm) => vm.id).sort(), ['ok'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, KIN_VM_READ_CACHE_MS: '0' },
  })
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
})
