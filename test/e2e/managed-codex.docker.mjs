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
import { queryOpenaiQuota, CHATGPT_USAGE_URL } from '../../src/lib/oauth/openai-quota.mjs'
import { CODEX_OAUTH_TOKEN_URL } from '../../src/lib/protocol/codex-models.mjs'
import { tryAcquireOpenAISlot, openAIRuntimeSignals } from '../../src/lib/pool/openai-account-runtime.mjs'

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
    patchVmRecord(root, vm.id, { status: 'creating', runtime: { type: 'docker' } })
    const recovered = await createManagedCodex(root, input)
    vm = getVm(root, vm.id)
    assert.equal(recovered.container.id, a.container.id, 'recover the existing container after an interrupted save')
    assert.equal(vm.status, 'running')
    assert.equal(vm.runtime.container_id, a.container.id)
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
    const statePath = path.join(root, 'vms', vm.id, 'run', 'container-state.json')
    const kernelBeforeQuota = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    const inFlight = tryAcquireOpenAISlot(vm.id, { concurrency: 2 })
    assert.ok(inFlight)
    try {
      let admitted = 0
      const quota = await queryOpenaiQuota({
        projectRoot: root,
        vmId: vm.id,
        fetchImpl: async (url) => {
          assert.equal(openAIRuntimeSignals(vm.id).inFlight, 1)
          const next = tryAcquireOpenAISlot(vm.id, { concurrency: 2 })
          if (next) {
            admitted++
            next.release()
          }
          return {
            status: 200,
            json: async () =>
              url === CHATGPT_USAGE_URL
                ? { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }
                : { credits: [] },
          }
        },
      })
      assert.equal(quota.ok, true)
      assert.equal(admitted, 2, 'usage polling must keep accepting requests')
      const kernelAfterQuota = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert.equal(kernelAfterQuota.pid, kernelBeforeQuota.pid, 'usage polling must not restart the kernel')
      assert.equal(kernelAfterQuota.revision, kernelBeforeQuota.revision)
      assert.equal(kernelAfterQuota.running, true)
      assert.equal(getVm(root, vm.id).schedulable, true)
    } finally {
      inFlight.release()
    }
    let refreshCalls = 0
    let refreshWasExclusive = false
    const renewedQuota = await queryOpenaiQuota({
      projectRoot: root,
      vmId: vm.id,
      fetchImpl: async (url, init) => {
        if (url === CODEX_OAUTH_TOKEN_URL) {
          refreshCalls++
          const lease = tryAcquireOpenAISlot(vm.id)
          const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
          refreshWasExclusive = lease === null && state.running === false
          lease?.release()
          return { status: 200, json: async () => ({ access_token: 'refreshed-at', refresh_token: 'refreshed-rt' }) }
        }
        if (url === CHATGPT_USAGE_URL) {
          if (init.headers.authorization !== 'Bearer refreshed-at') return { status: 401, json: async () => ({}) }
          return {
            status: 200,
            json: async () => ({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }),
          }
        }
        return { status: 200, json: async () => ({ credits: [] }) }
      },
    })
    assert.equal(renewedQuota.ok, true)
    assert.equal(refreshCalls, 1)
    assert.equal(refreshWasExclusive, true, 'only credential renewal drains and stops the guest')
    assert.equal(readCodexAccounts(root, vm.id)[0].refresh_token, 'refreshed-rt')
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).running, true)
    const afterRefresh = tryAcquireOpenAISlot(vm.id)
    assert.ok(afterRefresh, 'normal scheduling resumes after credential renewal')
    afterRefresh.release()
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
    docker('rm', '-f', other.container_name)
    await assert.rejects(createManagedCodex(root, { ...input, assignment_id: other.assignment_id }), {
      code: 'container_missing',
    })
    assert.equal(await inspectManagedContainer(other), null, 'do not create an orphan replacement')
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
