import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createCodexKernelSupervisor,
  writeCodexKernelConfig,
} from '../../src/lib/transport/codex-kernel-supervisor.mjs'

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-supervisor-'))
  const saved = process.env.KIN_CODEX_KERNEL_BIN
  process.env.KIN_CODEX_KERNEL_BIN = process.execPath
  const vm = { id: 'vm-codex', platform: 'openai', fingerprint: { device_id: 'device-old' } }
  const vmPath = path.join(root, 'vms', `${vm.id}.json`)
  fs.mkdirSync(path.join(root, 'vms', vm.id, 'run'), { recursive: true })
  fs.writeFileSync(vmPath, JSON.stringify(vm))
  const exec = { vm, vmId: vm.id, vmPath, homeDir: path.join(root, 'vms', vm.id, 'cli-home') }
  const socket = path.join(root, 'vms', vm.id, 'run', 'codex-kernel.sock')
  const children = []
  let healthy = true
  const supervisor = createCodexKernelSupervisor({
    discover: () => [],
    spawnKernel: () => {
      const child = new EventEmitter()
      Object.assign(child, {
        pid: 1000000 + children.length,
        exitCode: null,
        signalCode: null,
        signals: [],
        unref() {},
      })
      child.exit = (code = 0, signal = null) => {
        child.exitCode = code
        child.signalCode = signal
        child.emit('exit', code, signal)
      }
      child.kill = (signal) => {
        child.signals.push(signal)
        if (!options.ignoreAll && !(options.ignoreTerm && signal === 'SIGTERM'))
          queueMicrotask(() => child.exit(null, signal))
        return true
      }
      children.push(child)
      fs.writeFileSync(socket, 'live socket placeholder')
      if (options.spawnError)
        queueMicrotask(() => {
          child.pid = undefined
          child.exitCode = -2
          child.emit('error', new Error('spawn failed'))
        })
      return child
    },
    health:
      options.health ||
      (async () => ({
        ok:
          healthy &&
          children.at(-1)?.exitCode === null &&
          children.at(-1)?.signalCode === null &&
          fs.existsSync(socket),
      })),
  })
  t.after(async () => {
    options.ignoreAll = false
    await supervisor.stopAll()
    if (saved === undefined) delete process.env.KIN_CODEX_KERNEL_BIN
    else process.env.KIN_CODEX_KERNEL_BIN = saved
    fs.rmSync(root, { recursive: true, force: true })
  })
  return {
    root,
    exec,
    vmPath,
    socket,
    children,
    supervisor,
    unhealthy: () => {
      healthy = false
    },
  }
}

test('parallel ensures start one process; exited children do not poison later starts', async (t) => {
  const f = fixture(t)
  const results = await Promise.all(Array.from({ length: 12 }, () => f.supervisor.ensure(f.exec, { timeoutMs: 200 })))
  assert.ok(results.every((r) => r.ok))
  assert.equal(f.children.length, 1)
  f.children[0].exit(1)
  assert.equal((await f.supervisor.ensure(f.exec, { timeoutMs: 200 })).ok, true)
  assert.equal(f.children.length, 2)
})

test('a missing socket is repaired only after its old process has exited', async (t) => {
  const f = fixture(t)
  await f.supervisor.ensure(f.exec, { timeoutMs: 200 })
  fs.unlinkSync(f.socket)
  assert.equal((await f.supervisor.ensure(f.exec, { timeoutMs: 200 })).ok, true)
  assert.equal(f.children.length, 2)
  assert.equal(f.children[0].signalCode, 'SIGTERM')
  assert.ok(fs.existsSync(f.socket))
})

test('health timeouts retain the live process and socket for later stop', async (t) => {
  const f = fixture(t)
  await f.supervisor.ensure(f.exec, { timeoutMs: 200 })
  f.unhealthy()
  const result = await f.supervisor.ensure(f.exec, { timeoutMs: 200 })
  assert.equal(result.reason, 'health_timeout')
  assert.equal(f.children.length, 1)
  assert.deepEqual(f.children[0].signals, [])
  assert.equal(fs.readFileSync(f.socket, 'utf8'), 'live socket placeholder')
  assert.equal((await f.supervisor.stop(f.exec.vmId, { projectRoot: f.root })).ok, true)
  assert.equal(f.children[0].signalCode, 'SIGTERM')
})

test('stop cancels an ensure already waiting for health, without a late spawn', async (t) => {
  let release, entered
  const began = new Promise((resolve) => {
    entered = resolve
  })
  const f = fixture(t, {
    health: () => {
      entered()
      return new Promise((resolve) => {
        release = resolve
      })
    },
  })
  const starting = f.supervisor.ensure(f.exec)
  await began
  const stopping = f.supervisor.stop(f.exec.vmId, { projectRoot: f.root })
  assert.equal((await f.supervisor.ensure(f.exec)).reason, 'kernel_stopping')
  release({ ok: false })
  assert.equal((await starting).ok, false)
  assert.equal((await stopping).ok, true)
  assert.equal(f.children.length, 0)
})

test('spawn errors are handled and the next ensure can retry', async (t) => {
  const options = { spawnError: true }
  const f = fixture(t, options)
  assert.equal((await f.supervisor.ensure(f.exec, { timeoutMs: 200 })).ok, false)
  options.spawnError = false
  assert.equal((await f.supervisor.ensure(f.exec, { timeoutMs: 200 })).ok, true)
  assert.equal(f.children.length, 2)
})

test('stop escalates to SIGKILL and confirms exit', async (t) => {
  const f = fixture(t, { ignoreTerm: true })
  await f.supervisor.ensure(f.exec, { timeoutMs: 200 })
  const result = await f.supervisor.stop(f.exec.vmId, { projectRoot: f.root, timeoutMs: 10 })
  assert.equal(result.ok, true)
  assert.equal(result.forced, true)
  assert.deepEqual(f.children[0].signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(f.children[0].signalCode, 'SIGKILL')
})

test('a failed stop keeps ownership so retry can still terminate the process', async (t) => {
  const options = { ignoreAll: true }
  const f = fixture(t, options)
  await f.supervisor.ensure(f.exec, { timeoutMs: 200 })
  const result = await f.supervisor.stop(f.exec.vmId, { projectRoot: f.root, timeoutMs: 10, killTimeoutMs: 10 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'codex_stop_timeout')
  options.ignoreAll = false
  assert.equal((await f.supervisor.stop(f.exec.vmId, { projectRoot: f.root })).ok, true)
  assert.equal(f.children[0].signalCode, 'SIGTERM')
})

test('reset state and replaced fingerprint block stale requests from writing or starting', async (t) => {
  const f = fixture(t)
  for (const patch of [
    { status: 'rebuilding' },
    { status: 'deleting' },
    { fingerprint: { device_id: 'new-device' } },
  ]) {
    fs.writeFileSync(f.vmPath, JSON.stringify({ ...f.exec.vm, ...patch }))
    assert.equal((await f.supervisor.ensure(f.exec)).ok, false)
    assert.throws(() => writeCodexKernelConfig(f.root, f.exec.vm), /slot_(rebuilding|deleting|replaced)/)
  }
  fs.unlinkSync(f.vmPath)
  assert.equal((await f.supervisor.ensure(f.exec)).reason, 'slot_unavailable')
  assert.equal(f.children.length, 0)
})
