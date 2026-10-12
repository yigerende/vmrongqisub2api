// Real legacy GPT containers and the pinned host kernel; fake credentials only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { getVm, patchVmRecord } from '../../src/lib/vm/vm-registry.mjs'
import { recreateVmFiles } from '../../src/lib/vm/vm-recreate.mjs'
import { startSlotReady, slotExec, ensureSlotInferenceRuntime } from '../../src/lib/vm/slot-runtime.mjs'
import { containerName } from '../../src/lib/vm/vm-runtime.mjs'
import { upsertCodexAccount, readCodexAccounts } from '../../src/lib/vm/codex-slot.mjs'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { codexKernelHealth, codexKernelPaths } from '../../src/lib/transport/codex-kernel-client.mjs'
import {
  ensureCodexKernel,
  stopCodexKernel,
  writeCodexKernelConfig,
} from '../../src/lib/transport/codex-kernel-supervisor.mjs'
import { tryAcquireOpenAISlot, openAIRuntimeSignals } from '../../src/lib/pool/openai-account-runtime.mjs'

const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function kernelPids(configPath) {
  return fs
    .readdirSync('/proc')
    .filter((pid) => {
      if (!/^\d+$/.test(pid)) return false
      try {
        const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
        return args.length === 2 && args[1] === configPath
      } catch {
        return false
      }
    })
    .map(Number)
}

test('legacy reset reaps host kernels before wiping files, and can repeat without restarting the panel', {
  skip: process.env.KIN_DOCKER_TEST !== '1',
  timeout: 180000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-reset-'))
  const suffix = crypto.randomBytes(5).toString('hex')
  const ids = [`gpt-reset-${suffix}`, `gpt-other-${suffix}`]
  const originalPath = process.env.PATH
  process.env.KIN_CODEX_KERNEL_BIN = path.resolve('bin/kin-codex-kernel')
  fs.mkdirSync(path.join(root, 'vms'))
  openDatabase({ dataDir: path.join(root, 'data') })
  let orphan
  const response = {}
  const handler = createPanelHandler({
    cfg: { paths: { project: root } },
    routingConfig: {},
    requireAuth(req) {
      req.apiKeyKind = 'master'
      req.panelRole = 'admin'
      return true
    },
    readBody: async () => ({}),
    proxyPool: { unbindVm() {} },
    json(_, status, body) {
      Object.assign(response, { status, body })
      return true
    },
  })
  const call = async (method, id, action = '') => {
    await handler({ method }, {}, new URL(`http://localhost/api/panel/vms/${id}${action ? '/' + action : ''}`))
    return { ...response }
  }
  const credential = (cycle) => ({
    email: `fixture-${cycle}@example.com`,
    access_token: `fake-at-${cycle}`,
    refresh_token: `fake-rt-${cycle}`,
    chatgpt_account_id: `fixture-${cycle}`,
  })
  const authorize = async (id, cycle) => {
    upsertCodexAccount(root, id, credential(cycle))
    const vm = getVm(root, id)
    assert.equal((await ensureSlotInferenceRuntime(vm, root)).ok, true)
    return slotExec(root, vm)
  }
  try {
    for (const id of ids) {
      const { vm } = recreateVmFiles(root, {
        id,
        name: id,
        platform: 'openai',
        family: 'codex',
        kernel: 'ubuntu-24.04',
        proxy: { id: 'px-local', scheme: 'local', host: 'local' },
        runtime: { type: 'docker' },
      })
      const boot = await startSlotReady(vm, root, { routing: { inference: { eager_start: false } } })
      assert.equal(boot.ok, true, JSON.stringify(boot))
      patchVmRecord(root, id, { status: 'running', runtime: boot.docker.runtime })
    }
    let exec = await authorize(ids[0], 0)
    const other = await authorize(ids[1], 99)
    const otherPids = kernelPids(codexKernelPaths(other).configPath)
    assert.equal(otherPids.length, 1)
    for (let cycle = 1; cycle <= 2; cycle++) {
      const paths = codexKernelPaths(exec)
      const oldPids = kernelPids(paths.configPath)
      const oldDevice = exec.vm.fingerprint.device_id
      assert.equal(oldPids.length, 1)
      const lease = tryAcquireOpenAISlot(ids[0])
      assert.ok(lease)
      try {
        const reset = await call('POST', ids[0], 'reset')
        assert.equal(reset.status, 200, JSON.stringify(reset.body))
        assert.equal(openAIRuntimeSignals(ids[0]).inFlight, 1, 'reset does not wait for requests to drain')
      } finally {
        lease.release()
      }
      assert.deepEqual(kernelPids(paths.configPath), [])
      assert.equal(fs.existsSync(paths.socketPath), false)
      assert.deepEqual(readCodexAccounts(root, ids[0]), [])
      const fresh = getVm(root, ids[0])
      assert.notEqual(fresh.fingerprint.device_id, oldDevice)
      assert.equal(fresh.schedulable, false)
      assert.equal(fresh.status, 'running')
      assert.equal(fresh.schedule_disabled_reason, 'no_credential')
      assert.equal(
        (await ensureCodexKernel(exec)).reason,
        'slot_replaced',
        'stale callers cannot relaunch the old generation',
      )
      assert.deepEqual(kernelPids(codexKernelPaths(other).configPath), otherPids)
      assert.equal((await codexKernelHealth(other)).ok, true)
      exec = await authorize(ids[0], cycle)
      const config = JSON.parse(fs.readFileSync(codexKernelPaths(exec).configPath, 'utf8'))
      assert.equal(config.device_id, fresh.fingerprint.device_id)
      assert.equal(readCodexAccounts(root, ids[0])[0].access_token, `fake-at-${cycle}`)
      assert.equal(kernelPids(config.socket_path.replace('codex-kernel.sock', 'codex-kernel.json')).length, 1)
    }
    // A kernel inherited from an older control process has no entry in starts.
    await stopCodexKernel(ids[0], { projectRoot: root })
    const paths = writeCodexKernelConfig(root, getVm(root, ids[0]))
    try {
      fs.unlinkSync(paths.socketPath)
    } catch {}
    orphan = spawn(process.env.KIN_CODEX_KERNEL_BIN, [paths.configPath], { stdio: 'ignore' })
    for (let i = 0; i < 100 && !(await codexKernelHealth(exec).catch(() => null))?.ok; i++) await pause(20)
    assert.equal((await codexKernelHealth(exec)).ok, true)
    fs.unlinkSync(paths.socketPath) // reproduce the original unlinked-but-still-live kernel
    const deleted = await call('DELETE', ids[0])
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body))
    assert.deepEqual(kernelPids(paths.configPath), [])
    assert.equal(getVm(root, ids[0]), null)
    assert.equal(fs.existsSync(path.join(root, 'vms', ids[0])), false)
    assert.equal((await codexKernelHealth(other)).ok, true)

    // Missing container + failed Docker boot must report failure, never fake success.
    docker('rm', '-f', containerName(ids[1]))
    const fakeBin = path.join(root, 'fake-bin')
    fs.mkdirSync(fakeBin)
    fs.writeFileSync(path.join(fakeBin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    process.env.PATH = `${fakeBin}:${originalPath}`
    const failed = await call('POST', ids[1], 'reset')
    assert.equal(failed.status, 500, JSON.stringify(failed.body))
    assert.equal(getVm(root, ids[1]).schedulable, false)
    assert.equal(getVm(root, ids[1]).status, 'stopped')
    assert.deepEqual(kernelPids(codexKernelPaths(other).configPath), [])
  } finally {
    process.env.PATH = originalPath
    orphan?.kill('SIGKILL')
    for (const id of ids) {
      await stopCodexKernel(id, { projectRoot: root })
      try {
        docker('rm', '-f', containerName(id))
      } catch {}
    }
    closeDatabase()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
