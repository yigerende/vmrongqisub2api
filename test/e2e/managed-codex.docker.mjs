// Disposable Linux runner only. Uses the real pinned kernel, with fake OAuth;
// health checks do not call OpenAI or spend an account's quota.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { createManagedCodex, importManagedCodex, handleManagedCodex } from '../../src/lib/admin/managed-codex.mjs'
import { getVm, patchVmRecord } from '../../src/lib/vm/vm-registry.mjs'
import { inspectManagedContainer, ensureManagedKernel, managedExec } from '../../src/lib/vm/codex-container.mjs'
import { readCodexAccounts, upsertCodexAccount } from '../../src/lib/vm/codex-slot.mjs'
import { imageForKernel } from '../../src/lib/vm/os-catalog.mjs'

test('real one-slot Docker: idempotency, guest kernel, reauth, ownership and deletion', {
  skip: process.env.KIN_DOCKER_TEST !== '1',
  timeout: 240000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'space-docker-'))
  process.env.KIN_CODEX_KERNEL_BIN = path.resolve('bin/kin-codex-kernel')
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
  openDatabase({ dataDir: path.join(root, 'data') })
  const sentinel = `space-unrelated-${crypto.randomBytes(5).toString('hex')}`
  const input = {
    assignment_id: `space-${crypto.randomBytes(24).toString('hex')}`,
    account_email: 'fixture+one@example.com',
    platform: 'openai',
    runtime_type: 'docker',
    execution_mode: 'docker_per_slot',
    proxy_id: 'px-local',
    machine: { memory: '512m' },
  }
  let vm
  let other
  const call = async (method, action, body = {}) => {
    let out
    await handleManagedCodex({
      req: { method, headers: { 'x-space-assignment': vm.assignment_id } },
      res: {},
      url: new URL(`http://localhost/api/panel/vms/${vm.id}${action ? '/' + action : ''}`),
      cfg: { paths: { project: root } },
      routing: {},
      readBody: async () => body,
      json: (_, status, payload) => {
        out = { status, payload }
        return true
      },
    })
    return out
  }
  try {
    docker('run', '-d', '--name', sentinel, imageForKernel('ubuntu-24.04'), 'sleep', 'infinity')
    const [a, b] = await Promise.all([createManagedCodex(root, input), createManagedCodex(root, input)])
    assert.equal(a.vm.id, b.vm.id)
    assert.equal(a.container.id, b.container.id)
    vm = getVm(root, a.vm.id)
    assert.equal(vm.pool_id, null, 'global key needs no pool')
    const credential = {
      email: input.account_email,
      access_token: 'fixture-at',
      refresh_token: 'fixture-rt',
      chatgpt_account_id: 'fixture-account',
    }
    await importManagedCodex(root, vm, credential)
    const health = await ensureManagedKernel(managedExec(root, getVm(root, vm.id)))
    assert.equal(health.ok, true)
    assert.match(docker('top', vm.container_name, '-eo', 'pid,args'), /kin-codex-kernel/)
    const info = JSON.parse(docker('inspect', vm.container_name))[0]
    assert.equal(info.HostConfig.Privileged, false)
    assert.equal(info.HostConfig.NetworkMode, 'bridge')
    assert.ok(!info.Mounts.some((m) => /docker.sock/.test(m.Source)))
    assert.equal(docker('exec', vm.container_name, 'cat', '/etc/machine-id'), vm.fingerprint.guest_machine_id)
    assert.equal((await call('POST', 'schedulable', { schedulable: true })).status, 200)
    // An ambiguous import retry must not overwrite tokens already rotated by the guest.
    upsertCodexAccount(root, vm.id, { ...readCodexAccounts(root, vm.id)[0], refresh_token: 'rotated-rt' })
    await importManagedCodex(root, getVm(root, vm.id), credential)
    assert.equal(readCodexAccounts(root, vm.id)[0].refresh_token, 'rotated-rt')
    assert.equal((await call('POST', 'schedulable', { schedulable: false })).status, 200)
    await importManagedCodex(root, getVm(root, vm.id), {
      ...credential,
      access_token: 'new-at',
      refresh_token: 'new-rt',
    })
    assert.equal(getVm(root, vm.id).schedulable, false)
    assert.equal((await inspectManagedContainer(vm)).id, a.container.id)
    const second = await createManagedCodex(root, {
      ...input,
      assignment_id: `space-${crypto.randomBytes(24).toString('hex')}`,
    })
    other = getVm(root, second.vm.id)
    assert.notEqual(other.container_name, vm.container_name)
    assert.notEqual(other.fingerprint.device_id, vm.fingerprint.device_id)
    const originalName = vm.container_name
    patchVmRecord(root, vm.id, { container_name: sentinel })
    assert.equal((await call('DELETE', '')).status, 409, 'must refuse an unrelated container')
    patchVmRecord(root, vm.id, { container_name: originalName })
    assert.equal((await call('DELETE', '')).status, 200)
    assert.equal((await call('DELETE', '')).status, 200)
    assert.equal(fs.existsSync(path.join(root, 'vms', vm.id)), false)
    assert.equal(getVm(root, vm.id), null)
    assert.equal((await inspectManagedContainer(other)).running, true)
    assert.equal(JSON.parse(docker('inspect', sentinel))[0].State.Running, true)
    await assert.rejects(createManagedCodex(root, input), { code: 'assignment_deleted' })
  } catch (error) {
    // Only disposable fixture containers; never print credential/config files.
    const id = `space-${crypto.createHash('sha256').update(input.assignment_id).digest('hex').slice(0, 24)}`
    vm ||= getVm(root, id)
    if (vm?.container_name) {
      try {
        console.error(docker('logs', '--tail', '20', vm.container_name))
      } catch {}
      try {
        console.error(fs.readFileSync(path.join(root, 'vms', id, 'run', 'container-state.json'), 'utf8'))
      } catch {}
    }
    throw error
  } finally {
    for (const name of [vm?.container_name, other?.container_name, sentinel].filter(Boolean)) {
      try {
        docker('rm', '-f', name)
      } catch {}
    }
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
