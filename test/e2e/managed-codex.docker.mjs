// Disposable Linux runner only. Uses the real pinned kernel, with fake OAuth;
// health checks do not call OpenAI or spend an account's quota.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { VmPoolsRepo } from '../../src/lib/db/repos/vm-pools-repo.mjs'
import { createManagedCodex, importManagedCodex, handleManagedCodex } from '../../src/lib/admin/managed-codex.mjs'
import { getVm, patchVmRecord, summarizeVm } from '../../src/lib/vm/vm-registry.mjs'
import { changeVmQualitySchedule } from '../../src/lib/admin/vm-quality-schedule.mjs'
import { invalidateReadCache } from '../../src/lib/vm/vm-file.mjs'
import { inspectManagedContainer, ensureManagedKernel, managedExec } from '../../src/lib/vm/codex-container.mjs'
import { readCodexAccounts, upsertCodexAccount } from '../../src/lib/vm/codex-slot.mjs'
import { imageForKernel } from '../../src/lib/vm/os-catalog.mjs'
import { queryOpenaiQuota, CHATGPT_USAGE_URL } from '../../src/lib/oauth/openai-quota.mjs'
import { tryAcquireOpenAISlot, openAIRuntimeSignals } from '../../src/lib/pool/openai-account-runtime.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { streamCodexKernel } from '../../src/lib/transport/codex-kernel-client.mjs'

// Records SOCKS destinations, then refuses them: no test traffic reaches OpenAI.
async function refusingSocks() {
  const destinations = []
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    let buffered = Buffer.alloc(0)
    let greeted = false
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk])
      if (!greeted) {
        if (buffered.length < 2 || buffered.length < 2 + buffered[1]) return
        buffered = buffered.subarray(2 + buffered[1])
        greeted = true
        socket.write(Buffer.from([5, 0]))
      }
      if (buffered.length < 5) return
      const size = buffered[3] === 3 ? 7 + buffered[4] : buffered[3] === 1 ? 10 : 22
      if (buffered.length < size) return
      destinations.push(buffered[3] === 3 ? buffered.subarray(5, 5 + buffered[4]).toString() : 'ip')
      socket.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]))
    })
  })
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve))
  return {
    port: server.address().port,
    destinations,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const kvm = process.env.KIN_MANAGED_RUNTIME === 'kvm'
const guestOS = kvm ? process.env.KIN_KVM_TEST_OS || 'debian-12' : 'ubuntu-24.04'
test(`real one-slot ${kvm ? 'KVM' : 'Docker'}: idempotency, guest kernel, reauth, ownership and deletion`, {
  skip: process.env.KIN_DOCKER_TEST !== '1',
  timeout: kvm ? 900000 : 240000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'space-docker-'))
  process.env.KIN_CODEX_KERNEL_BIN = path.resolve('bin/kin-codex-kernel')
  const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim()
  openDatabase({ dataDir: path.join(root, 'data') })
  const groups = new VmPoolsRepo()
  const groupA = groups.insert({ name: 'Team' }),
    groupB = groups.insert({ name: 'Pro' })
  const proxyPool = new ProxyPool({ dataDir: path.join(root, 'data') })
  proxyPool.ensureLocal()
  const create = (body) => createManagedCodex(root, body, {}, proxyPool)
  const sentinel = `space-unrelated-${crypto.randomBytes(5).toString('hex')}`
  const input = {
    assignment_id: `space-${crypto.randomBytes(24).toString('hex')}`,
    account_email: 'fixture+one@example.com',
    platform: 'openai',
    runtime_type: kvm ? 'kvm' : 'docker',
    execution_mode: kvm ? 'kvm_per_slot' : 'docker_per_slot',
    kernel: guestOS,
    proxy_id: 'px-local',
    group_ids: [groupA.id, groupB.id],
    machine: { memory: kvm ? '1g' : '512m', vcpus: 2, disk_gb: 20 },
  }
  let vm
  let other
  let socks
  const call = async (method, action, body = {}, slot = vm) => {
    let out
    await handleManagedCodex({
      req: { method, headers: { 'x-space-assignment': slot.assignment_id } },
      res: {},
      url: new URL(`http://localhost/api/panel/vms/${slot.id}${action ? '/' + action : ''}`),
      cfg: { paths: { project: root } },
      routing: {},
      proxyPool,
      readBody: async () => body,
      json: (_, status, payload) => {
        out = { status, payload }
        return true
      },
    })
    return out
  }
  try {
    docker('run', '-d', '--name', sentinel, kvm ? 'busybox:1.37' : imageForKernel('ubuntu-24.04'), 'sleep', '10000')
    const [a, b] = await Promise.all([create(input), create(input)])
    assert.equal(a.vm.id, b.vm.id)
    assert.equal(a.container.id, b.container.id)
    vm = getVm(root, a.vm.id)
    assert.equal(vm.pool_id, null, 'global key needs no pool')
    assert.equal(vm.proxy.id, 'px-local')
    assert.equal(vm.proxy_cli_enabled, true)
    assert.deepEqual(proxyPool.snapshot().proxies.find((p) => p.id === 'px-local').bound_vm_ids, [vm.id])
    patchVmRecord(root, vm.id, { status: 'creating', runtime: { type: kvm ? 'kvm' : 'docker' } })
    const recovered = await create(input)
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
    const guest = (slot, ...argv) =>
      docker('exec', slot.container_name, ...(kvm ? ['kin-guest-exec', '--'] : []), ...argv)
    if (kvm) {
      assert.doesNotMatch(
        docker('top', vm.container_name, '-eo', 'pid,args'),
        /kin-codex-kernel/,
        'Codex must run inside QEMU, never on the runner',
      )
      assert.match(guest(vm, 'ps', '-eo', 'args'), /\/slot\/bin\/kin-codex-kernel/)
      assert.equal(guest(vm, 'cat', '/sys/class/dmi/id/product_uuid').toLowerCase(), vm.machine.smbios.uuid)
      const pinned = await create({
        ...input,
        runtime_type: 'docker',
        execution_mode: 'docker_per_slot',
        machine: { memory: '8g' },
      })
      assert.equal(pinned.container.id, a.container.id)
      assert.equal(getVm(root, vm.id).machine.memory, '1g')
      assert.equal(getVm(root, vm.id).runtime.type, 'kvm')
    } else assert.match(docker('top', vm.container_name, '-eo', 'pid,args'), /kin-codex-kernel/)
    const info = JSON.parse(docker('inspect', vm.container_name))[0]
    assert.equal(info.HostConfig.Privileged, false)
    assert.equal(info.HostConfig.NetworkMode, 'bridge')
    assert.ok(!info.Mounts.some((m) => /docker.sock/.test(m.Source)))
    assert.equal(guest(vm, 'cat', '/etc/machine-id'), vm.fingerprint.guest_machine_id)
    assert.equal((await call('POST', 'schedulable', { schedulable: true })).status, 200)
    for (const group of [groupA, groupB]) assert.deepEqual(groups.get(group.id).vm_ids, [vm.id])
    groups.setMembers(groupA.id, [])
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
    const rejectedQuota = await queryOpenaiQuota({
      projectRoot: root,
      vmId: vm.id,
      fetchImpl: async (url) => {
        assert.equal(url, CHATGPT_USAGE_URL, 'a rejected quota probe must not start credential maintenance')
        return { status: 401, json: async () => ({}) }
      },
    })
    assert.equal(rejectedQuota.upstream_status, 401)
    assert.equal(readCodexAccounts(root, vm.id)[0].refresh_token, credential.refresh_token)
    const afterRejectedQuota = JSON.parse(fs.readFileSync(statePath, 'utf8'))
    assert.equal(afterRejectedQuota.pid, kernelBeforeQuota.pid)
    assert.equal(afterRejectedQuota.revision, kernelBeforeQuota.revision)
    assert.equal(afterRejectedQuota.running, true)
    const qualityLease = tryAcquireOpenAISlot(vm.id)
    assert.ok(qualityLease)
    try {
      const paused = changeVmQualitySchedule(root, summarizeVm(getVm(root, vm.id), root), false)
      assert.equal(paused.schedulable, false)
      assert.equal(openAIRuntimeSignals(vm.id).inFlight, 1, 'quality pause leaves existing requests running')
      assert.equal((await inspectManagedContainer(vm)).id, a.container.id)
      const pausedKernel = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert.equal(pausedKernel.pid, kernelBeforeQuota.pid)
      assert.equal(pausedKernel.revision, kernelBeforeQuota.revision)
      assert.equal(pausedKernel.running, true)
      // Pinned diagnostics can still reach this same guest for recovery.
      assert.equal((await ensureManagedKernel(managedExec(root, getVm(root, vm.id)))).ok, true)
      assert.equal(changeVmQualitySchedule(root, summarizeVm(getVm(root, vm.id), root), true).schedulable, true)
      assert.equal(openAIRuntimeSignals(vm.id).inFlight, 1)
    } finally {
      qualityLease.release()
    }
    const afterProbe = tryAcquireOpenAISlot(vm.id)
    assert.ok(afterProbe, 'a rejected quota probe must not disable scheduling')
    afterProbe.release()
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
    assert.equal((await call('POST', 'schedulable', { schedulable: true })).status, 200)
    assert.deepEqual(groups.get(groupA.id).vm_ids, [], 'reauth and resume preserve operator membership edits')
    assert.deepEqual(groups.get(groupB.id).vm_ids, [vm.id])
    socks = await refusingSocks()
    const gateway = JSON.parse(docker('network', 'inspect', 'bridge'))[0].IPAM.Config[0].Gateway
    const chosenProxy = proxyPool.importLines(`${gateway}:${socks.port}`).items[0].id
    const second = await create({
      ...input,
      assignment_id: `space-${crypto.randomBytes(24).toString('hex')}`,
      proxy_ids: [chosenProxy],
    })
    other = getVm(root, second.vm.id)
    assert.notEqual(other.container_name, vm.container_name)
    assert.notEqual(other.fingerprint.device_id, vm.fingerprint.device_id)
    await importManagedCodex(root, other, credential)
    assert.equal((await call('POST', 'schedulable', { schedulable: true }, other)).status, 200)
    assert.deepEqual(groups.get(groupB.id).vm_ids, [vm.id, other.id].sort())
    if (kvm) {
      assert.notEqual(guest(vm, 'cat', '/etc/machine-id'), guest(other, 'cat', '/etc/machine-id'))
      assert.notEqual(
        guest(vm, 'cat', '/proc/sys/kernel/random/boot_id'),
        guest(other, 'cat', '/proc/sys/kernel/random/boot_id'),
      )
      assert.notEqual(
        guest(vm, 'cat', '/sys/class/dmi/id/product_uuid'),
        guest(other, 'cat', '/sys/class/dmi/id/product_uuid'),
      )
      assert.notEqual(
        fs.readFileSync(path.join(root, 'vms', vm.id, 'kvm', 'instance-id'), 'utf8'),
        fs.readFileSync(path.join(root, 'vms', other.id, 'kvm', 'instance-id'), 'utf8'),
      )
    }
    const guestConfig = JSON.parse(docker('exec', other.container_name, 'cat', '/slot/run/codex-kernel.json'))
    assert.equal(guestConfig.proxy_url, `socks5h://${gateway}:${socks.port}`)
    assert.equal(guestConfig.proxy_required, true)
    const proxyFailure = await streamCodexKernel({
      exec: managedExec(root, getVm(root, other.id)),
      envelope: { body: { model: 'gpt-5.1-codex', input: 'fixture', stream: true }, headers: {}, stream: true },
      timeoutMs: 5000,
      onEvent: async () => {},
    })
    assert.equal(proxyFailure.ok, false)
    assert.ok(
      socks.destinations.includes('chatgpt.com'),
      'the real guest kernel must dial through the chosen SOCKS proxy',
    )
    const originalName = vm.container_name
    const activeAtDelete = tryAcquireOpenAISlot(vm.id)
    assert.ok(activeAtDelete)
    try {
      patchVmRecord(root, vm.id, { container_name: sentinel })
      assert.equal((await call('DELETE', '')).status, 409, 'must refuse an unrelated container')
      assert.equal(proxyPool.getProxyForVm(vm.id).id, 'px-local', 'failed deletion must keep the binding')
      patchVmRecord(root, vm.id, { container_name: originalName })
      const recordPath = path.join(root, 'vms', `${vm.id}.json`)
      const credentialPath = path.join(root, 'vms', vm.id, 'codex-credentials.json')
      assert.equal(getVm(root, vm.id).id, vm.id)
      assert.equal(readCodexAccounts(root, vm.id)[0].refresh_token, 'new-rt')
      assert.equal((await call('DELETE', '')).status, 200, 'delete must not wait for active requests')
      assert.equal(invalidateReadCache(recordPath), false, 'deletion must evict the slot record')
      assert.equal(invalidateReadCache(credentialPath), false, 'deletion must evict cached OAuth credentials')
      assert.equal(readCodexAccounts(root, vm.id).length, 0)
      assert.equal(readCodexAccounts(root, other.id)[0].refresh_token, credential.refresh_token)
      assert.equal(proxyPool.getProxyForVm(vm.id), null, 'successful deletion releases the local binding')
      assert.equal(proxyPool.getProxyForVm(other.id).id, chosenProxy, 'other slots retain their bindings')
      for (const group of [groupA, groupB]) assert.deepEqual(groups.get(group.id).vm_ids, [other.id])
      assert.equal(openAIRuntimeSignals(vm.id).inFlight, 1, 'the held request has not drained')
    } finally {
      activeAtDelete.release()
    }
    assert.equal((await call('DELETE', '')).status, 200)
    assert.equal(fs.existsSync(path.join(root, 'vms', vm.id)), false)
    assert.equal(getVm(root, vm.id), null)
    assert.equal((await inspectManagedContainer(other)).running, true)
    assert.equal(JSON.parse(docker('inspect', sentinel))[0].State.Running, true)
    await assert.rejects(create(input), { code: 'assignment_deleted' })
    docker('rm', '-f', other.container_name)
    await assert.rejects(create({ ...input, assignment_id: other.assignment_id }), {
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
    await socks?.close()
    for (const name of [vm?.container_name, other?.container_name, sentinel].filter(Boolean)) {
      try {
        docker('rm', '-f', name)
      } catch {}
    }
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
