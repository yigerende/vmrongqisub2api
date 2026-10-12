/**
 * Host-side Codex kernel lifecycle. Dedicated Codex VMs listen on
 * vms/<id>/run/codex-kernel.sock; Claude workers are never reused.
 */
import { managedCodex, ensureManagedKernel, writeManagedConfig } from '../vm/codex-container.mjs'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { boundProxyUrl, isLocalEgressProxy, localEgressProxyUrl } from '../vm/egress.mjs'
import { assertProxyAllowed } from '../vm/proxy-policy.mjs'
import { codexKernelHealth, codexKernelPaths } from './codex-kernel-client.mjs'

// The kernel exits only through config.proxy_url; inherited proxy variables would give it a second, unseen exit.
function kernelEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key)))
}

function existingBin(candidate) {
  const bin = String(candidate || '').trim()
  if (!bin) return ''
  try {
    fs.accessSync(bin, fs.constants.X_OK)
    return bin
  } catch {
    return ''
  }
}

export function codexKernelBinPath() {
  const env = existingBin(process.env.KIN_CODEX_KERNEL_BIN)
  if (env) return env
  const kernel = String(process.env.KIN_KERNEL_BIN || process.env.KIN_API_KERNEL_BIN || '').trim()
  if (kernel) {
    const sibling = existingBin(path.join(path.dirname(kernel), 'kin-codex-kernel'))
    if (sibling) return sibling
  }
  return existingBin(path.resolve('bin/kin-codex-kernel'))
}

export function writeCodexKernelConfig(projectRoot, vm, { token, proxyUrl, proxyRequired } = {}) {
  if (!projectRoot || !vm?.id) return null
  if (managedCodex(vm)) return writeManagedConfig(projectRoot, vm)
  const blocked = kernelStateError({ vm, vmPath: path.join(projectRoot, 'vms', `${vm.id}.json`) }, true)
  if (blocked) throw Object.assign(new Error(blocked), { code: blocked })
  assertProxyAllowed(vm.proxy)
  if (proxyUrl) assertProxyAllowed({ url: proxyUrl })
  const runDir = path.join(projectRoot, 'vms', vm.id, 'run')
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 })
  const socketPath = path.join(runDir, 'codex-kernel.sock')
  const configPath = path.join(runDir, 'codex-kernel.json')
  const tokenPath = path.join(runDir, 'internal.token')
  const credentialPath = path.join(projectRoot, 'vms', vm.id, 'codex-credentials.json')
  let secret = String(token || '').trim()
  if (!secret) {
    try {
      secret = fs.readFileSync(tokenPath, 'utf8').trim()
    } catch {}
  }
  if (!secret) secret = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(tokenPath, secret + '\n', { mode: 0o600 })
  const local = isLocalEgressProxy(vm?.proxy)
  const proxy = local ? localEgressProxyUrl() : String(proxyUrl || boundProxyUrl(vm?.proxy) || '').trim()
  // A configured deployment proxy is this slot's exit: fail closed instead of going direct.
  const required = local ? !!proxy : proxyRequired == null ? !!proxy : !!proxyRequired
  const deviceId = String(vm.device_id || vm.fingerprint?.device_id || vm.id).trim() || vm.id
  const config = {
    vm_id: vm.id,
    device_id: deviceId,
    socket_path: socketPath,
    credential_path: credentialPath,
    proxy_url: proxy,
    proxy_required: required,
    internal_token: secret,
    // Keep Codex slots aligned with the 32 MiB body budget in the bundled
    // kernel. Newer kernels can read this value; older binaries use the
    // patched 32 MiB default directly.
    max_request_bytes: 32 * 1024 * 1024,
    test_endpoints: process.env.KIN_CODEX_TEST_ENDPOINTS === '1',
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  return { runDir, socketPath, configPath, credentialPath, tokenPath }
}

// Check the current record too: a request can still hold the pre-reset VM object.
function kernelStateError(exec, allowMissing = false) {
  if (!exec.vmPath) return null
  let vm
  try {
    vm = JSON.parse(fs.readFileSync(exec.vmPath, 'utf8'))
  } catch (error) {
    return allowMissing && error.code === 'ENOENT' ? null : 'slot_unavailable'
  }
  if (['rebuilding', 'deleting'].includes(vm.status)) return `slot_${vm.status}`
  if (exec.vm?.fingerprint?.device_id && exec.vm.fingerprint.device_id !== vm.fingerprint?.device_id)
    return 'slot_replaced'
  return null
}

// Recover kernels left by a previous control-plane process. Match the executable,
// exact config argument, uid and Linux process start time; never kill by name alone.
function kernelProcess(pid, configPath, bin) {
  try {
    const dir = `/proc/${pid}`
    if (fs.statSync(dir).uid !== process.getuid()) return null
    const args = fs.readFileSync(`${dir}/cmdline`, 'utf8').split('\0').filter(Boolean)
    if (args.length !== 2 || path.resolve(fs.readlinkSync(`${dir}/cwd`), args[1]) !== configPath) return null
    if (fs.readlinkSync(`${dir}/exe`).replace(/ \(deleted\)$/, '') !== fs.realpathSync(bin)) return null
    const stat = fs.readFileSync(`${dir}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    if (fields[0] === 'Z') return null
    return { pid: Number(pid), configPath, bin, started: fields[19] }
  } catch {
    return null
  }
}

function discoverKernels(configPath, bin) {
  if (process.platform !== 'linux' || !bin) return []
  return fs
    .readdirSync('/proc')
    .filter((id) => /^\d+$/.test(id))
    .map((id) => kernelProcess(id, configPath, bin))
    .filter(Boolean)
}

const childAlive = (child) => !!child && child.exitCode === null && child.signalCode === null
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Isolated supervisors are also used by the lifecycle regression tests.
export function createCodexKernelSupervisor({
  spawnKernel = spawn,
  health = codexKernelHealth,
  discover = discoverKernels,
} = {}) {
  const starts = new Map()
  const starting = new Map()
  const stopping = new Map()
  const keyOf = (exec) => path.resolve(codexKernelPaths(exec).configPath)

  async function waitForHealth(exec, timeoutMs, cancelled, entry = null) {
    const deadline = Date.now() + Math.max(200, Number(timeoutMs) || 8000)
    let last = null
    while (Date.now() < deadline) {
      const blocked = cancelled() || kernelStateError(exec)
      if (blocked) return { ok: false, reason: typeof blocked === 'string' ? blocked : 'kernel_stopping' }
      if (entry?.error || (entry && !childAlive(entry.child)))
        return { ok: false, reason: 'kernel_exited', error: entry.error?.message }
      last = await health(exec, { timeoutMs: 500 }).catch((error) => ({ ok: false, error: error.message }))
      if (cancelled() || kernelStateError(exec)) return { ok: false, reason: 'kernel_stopping' }
      if (entry?.error || (entry && !childAlive(entry.child)))
        return { ok: false, reason: 'kernel_exited', error: entry.error?.message }
      if (last?.ok || Number(last?.status) === 200) return { ok: true, health: last }
      await pause(25)
    }
    return { ok: false, reason: 'health_timeout', health: last }
  }

  function trackedProcess(entry) {
    return {
      alive: () => childAlive(entry.child),
      signal: (signal) => entry.child.kill(signal),
    }
  }

  function recoveredProcess(ref) {
    const alive = () => kernelProcess(ref.pid, ref.configPath, ref.bin)?.started === ref.started
    return {
      alive,
      signal: (signal) => {
        if (alive()) process.kill(ref.pid, signal)
      },
    }
  }

  async function terminate(processes, timeoutMs = 2000, killTimeoutMs = 1000) {
    const signal = (kind) => {
      for (const proc of processes) {
        try {
          if (proc.alive()) proc.signal(kind)
        } catch {}
      }
    }
    const wait = async (ms) => {
      const deadline = Date.now() + ms
      while (processes.some((proc) => proc.alive()) && Date.now() < deadline) await pause(20)
      return processes.every((proc) => !proc.alive())
    }
    signal('SIGTERM')
    if (await wait(timeoutMs)) return { ok: true, action: 'stopped' }
    signal('SIGKILL')
    if (await wait(killTimeoutMs)) return { ok: true, action: 'stopped', forced: true }
    return { ok: false, code: 'codex_stop_timeout', error: 'Codex kernel did not exit' }
  }

  function ensure(exec, { timeoutMs = 8000 } = {}) {
    const paths = codexKernelPaths(exec)
    if (!paths.configPath) return Promise.resolve({ ok: false, reason: 'config_missing' })
    const key = keyOf(exec)
    if (stopping.has(key)) return Promise.resolve({ ok: false, reason: 'kernel_stopping' })
    const blocked = kernelStateError(exec)
    if (blocked) return Promise.resolve({ ok: false, reason: blocked })
    if (starting.has(key)) return starting.get(key).task
    const controller = new AbortController()
    const cancelled = () => controller.signal.aborted || stopping.has(key)
    const task = Promise.resolve()
      .then(async () => {
        const bin = codexKernelBinPath()
        if (!bin) return { ok: false, reason: 'bin_missing' }
        const live = await waitForHealth(exec, Math.min(800, timeoutMs), cancelled)
        if (cancelled() || kernelStateError(exec)) return { ok: false, reason: 'kernel_stopping' }
        if (live.ok) return { ...live, reused: true }
        const entry = starts.get(key)
        const processes = [
          ...(entry && childAlive(entry.child) ? [trackedProcess(entry)] : []),
          ...discover(key, bin)
            .filter((ref) => ref.pid !== entry?.child.pid)
            .map(recoveredProcess),
        ]
        if (processes.length) {
          // A slow health response is not permission to unlink a live socket.
          if (fs.existsSync(paths.socketPath)) return waitForHealth(exec, timeoutMs, cancelled, entry)
          const stopped = await terminate(processes)
          if (!stopped.ok) return { ...stopped, reason: stopped.code }
        }
        if (cancelled() || kernelStateError(exec)) return { ok: false, reason: 'kernel_stopping' }
        try {
          fs.unlinkSync(paths.socketPath)
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
        }
        const child = spawnKernel(bin, [paths.configPath], { env: kernelEnv(), stdio: 'ignore', detached: true })
        const next = { child, vmId: exec.vmId || exec.vm?.id, paths }
        starts.set(key, next)
        const drop = () => {
          if (starts.get(key) === next) starts.delete(key)
        }
        child.once('exit', drop)
        child.on('error', (error) => {
          next.error = error
          if (!child.pid || !childAlive(child)) drop()
        })
        child.unref()
        // Keep ownership of a live process even if health times out, so stop can reap it.
        return waitForHealth(exec, timeoutMs, cancelled, next)
      })
      .catch((error) => ({ ok: false, reason: error.code || 'kernel_start_failed', error: error.message }))
      .finally(() => {
        if (starting.get(key)?.task === task) starting.delete(key)
      })
    starting.set(key, { task, controller, vmId: exec.vmId || exec.vm?.id })
    return task
  }

  function stopKey(key, options) {
    if (stopping.has(key)) return stopping.get(key)
    starting.get(key)?.controller.abort()
    const task = Promise.resolve()
      .then(async () => {
        await starting.get(key)?.task
        const entry = starts.get(key)
        const processes = [
          ...(entry && childAlive(entry.child) ? [trackedProcess(entry)] : []),
          ...discover(key, codexKernelBinPath())
            .filter((ref) => ref.pid !== entry?.child.pid)
            .map(recoveredProcess),
        ]
        const result = await terminate(processes, options.timeoutMs, options.killTimeoutMs)
        if (!result.ok) return result
        if (starts.get(key) === entry) starts.delete(key)
        return { ...result, action: processes.length ? 'stopped' : 'absent' }
      })
      .catch((error) => ({ ok: false, code: error.code || 'codex_stop_failed', error: error.message }))
      .finally(() => {
        if (stopping.get(key) === task) stopping.delete(key)
      })
    stopping.set(key, task)
    return task
  }

  async function stop(vmId, options = {}) {
    const keys = options.projectRoot
      ? [path.resolve(options.projectRoot, 'vms', vmId, 'run', 'codex-kernel.json')]
      : [...new Set([...starts, ...starting].filter(([, entry]) => entry.vmId === vmId).map(([key]) => key))]
    const results = await Promise.all(keys.map((key) => stopKey(key, options)))
    return (
      results.find((result) => !result.ok) || { ok: true, action: 'stopped', forced: results.some((r) => r.forced) }
    )
  }

  return {
    ensure,
    stop,
    stopAll: () => Promise.all([...new Set([...starts.keys(), ...starting.keys()])].map((key) => stopKey(key, {}))),
  }
}

const supervisor = createCodexKernelSupervisor()

export async function ensureCodexKernel(exec, options = {}) {
  if (managedCodex(exec.vm)) {
    try {
      return await ensureManagedKernel(exec)
    } catch (e) {
      return { ok: false, reason: e.code, error: e.message }
    }
  }
  return supervisor.ensure(exec, options)
}

export function stopCodexKernel(vmId, options = {}) {
  return supervisor.stop(vmId, options)
}

export function stopAllCodexKernels() {
  return supervisor.stopAll()
}
