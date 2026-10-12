import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { atomicWriteJson, withVmLock } from './vm-file.mjs'
import { getVm, patchVmRecord } from './vm-registry.mjs'
import { toHostPath, hostMapEntries } from './host-path.mjs'
import { imageForKernel, OS_CATALOG } from './os-catalog.mjs'
import { slotMemory } from './machine-spec.mjs'
import { ensureGuestMachineIdFile } from '../identity/workstation-fingerprint.mjs'
import { codexKernelHealth } from '../transport/codex-kernel-client.mjs'
import { openAIRuntimeSignals, blockOpenAISlot } from '../pool/openai-account-runtime.mjs'
import { boundProxyUrl, isLocalEgressProxy } from './egress.mjs'

const execFileAsync = promisify(execFile)
const starting = new Map()
const mutations = new Set()
const runner = fileURLToPath(new URL('./codex-container-runner.py', import.meta.url))
export const managedCodex = (vm) => vm?.execution_mode === 'docker_per_slot'
const key = (root, id) => path.join(root, 'vms', `${id}.json`)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export function containerError(code, message = code, status = 409) {
  return Object.assign(new Error(message), { code, status })
}
export function accountContainerName(email, id) {
  const slug = String(email || 'account')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 55)
  return `kin-${slug || 'account'}-${crypto.createHash('sha256').update(id).digest('hex').slice(0, 12)}`
}
async function docker(args, timeout = 30000) {
  try {
    const result = await execFileAsync(process.env.KIN_DOCKER_BIN || 'docker', args, {
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    return result.stdout.trim()
  } catch (error) {
    if (args[0] === 'inspect' && /No such (object|container)/i.test(error.stderr || '')) return null
    throw containerError('docker_failed', String(error.stderr || error.message).slice(0, 700), 502)
  }
}
export async function inspectManagedContainer(vm) {
  const raw = await docker(['inspect', vm.container_name])
  if (raw == null) return null
  const info = JSON.parse(raw)[0]
  if (
    info.Config?.Labels?.['kin.vm.id'] !== vm.id ||
    info.Config?.Labels?.['kin.assignment'] !== vm.assignment_id ||
    info.Config?.Labels?.['kin.execution'] !== 'docker_per_slot' ||
    (vm.runtime?.container_id && vm.runtime.container_id !== info.Id)
  ) {
    throw containerError('container_ownership_mismatch', '容器归属不匹配，拒绝操作')
  }
  return {
    id: info.Id,
    name: vm.container_name,
    running: info.State?.Running === true,
    observed_at: new Date().toISOString(),
  }
}
export function assertManagedWritable(root, vm) {
  const current = getVm(root, vm.id)
  if (!current || current.assignment_id !== vm.assignment_id || current.status === 'deleting') {
    throw containerError('slot_unavailable', '槽位已删除或正在清理')
  }
  return current
}
function paths(root, id) {
  const dir = path.join(root, 'vms', id)
  return {
    dir,
    run: path.join(dir, 'run'),
    config: path.join(dir, 'run', 'codex-kernel.json'),
    control: path.join(dir, 'run', 'container-control.json'),
  }
}
export function writeManagedConfig(root, vm) {
  vm = assertManagedWritable(root, vm)
  const local = isLocalEgressProxy(vm.proxy)
  const proxyUrl = local ? '' : boundProxyUrl(vm.proxy)
  if (!local && !proxyUrl) throw containerError('proxy_required', '槽位未绑定可用代理')
  const p = paths(root, vm.id)
  fs.mkdirSync(p.run, { recursive: true, mode: 0o700 })
  const tokenPath = path.join(p.run, 'internal.token')
  if (!fs.existsSync(tokenPath)) fs.writeFileSync(tokenPath, crypto.randomBytes(24).toString('hex'), { mode: 0o600 })
  atomicWriteJson(
    p.config,
    {
      vm_id: vm.id,
      device_id: vm.fingerprint?.device_id || vm.device_id || vm.id,
      socket_path: '/slot/run/codex-kernel.sock',
      credential_path: '/slot/codex-credentials.json',
      internal_token: fs.readFileSync(tokenPath, 'utf8').trim(),
      proxy_url: proxyUrl,
      proxy_required: !local,
      max_request_bytes: 32 * 1024 * 1024,
    },
    { mode: 0o600 },
  )
}
export async function startManagedContainer(vm, root, { routing } = {}) {
  vm = assertManagedWritable(root, vm)
  let info = await inspectManagedContainer(vm)
  const wasRunning = info?.running === true
  if (!info && vm.runtime?.container_id)
    throw containerError('container_missing', '原账号容器已被外部删除，请删除槽位后开启新轮次')
  if (info) {
    if (!info.running) await docker(['start', info.id])
  } else {
    if (!OS_CATALOG[vm.kernel]) throw containerError('invalid_kernel')
    const p = paths(root, vm.id)
    fs.mkdirSync(path.join(p.dir, 'bin'), { recursive: true, mode: 0o700 })
    const bin = process.env.KIN_CODEX_KERNEL_BIN || path.join(root, 'bin', 'kin-codex-kernel')
    if (!fs.existsSync(bin)) throw containerError('bin_missing', 'Codex 内核文件不存在', 503)
    fs.copyFileSync(bin, path.join(p.dir, 'bin', 'kin-codex-kernel'))
    fs.chmodSync(path.join(p.dir, 'bin', 'kin-codex-kernel'), 0o555)
    fs.copyFileSync(runner, path.join(p.dir, 'bin', 'runner.py'))
    writeManagedConfig(root, vm)
    atomicWriteJson(p.control, { revision: crypto.randomUUID(), enabled: false }, { mode: 0o600 })
    const mapping = hostMapEntries({ projectRoot: root })
    if (
      fs.existsSync('/.dockerenv') &&
      !mapping.some((m) => p.dir === m.destination || p.dir.startsWith(m.destination + path.sep))
    ) {
      throw containerError(
        'mount_unavailable',
        '无法确认槽位的宿主挂载路径，请配置 VM2API_CONTAINER_NAME 或 VM2API_HOST_ROOT',
      )
    }
    const image = imageForKernel(vm.kernel)
    try {
      await docker(['image', 'inspect', image])
    } catch {
      await docker(['pull', image], 300000)
    }
    const memory = slotMemory(vm, routing)
    const machineId = ensureGuestMachineIdFile(root, vm)
    await docker(
      [
        'run',
        '-d',
        '--name',
        vm.container_name,
        '--hostname',
        vm.fingerprint.hostname,
        '--restart',
        'unless-stopped',
        '--stop-timeout',
        '10',
        '--network',
        'bridge',
        '--memory',
        memory,
        '--memory-swap',
        memory,
        '--pids-limit',
        '128',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,nosuid,size=32m',
        '--user',
        `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
        '--label',
        'kin.vm=1',
        '--label',
        `kin.vm.id=${vm.id}`,
        '--label',
        `kin.assignment=${vm.assignment_id}`,
        '--label',
        'kin.vm.role=codex',
        '--label',
        'kin.execution=docker_per_slot',
        '--mount',
        `type=bind,src=${toHostPath(p.dir, { projectRoot: root })},dst=/slot`,
        ...(machineId
          ? ['--mount', `type=bind,src=${toHostPath(machineId, { projectRoot: root })},dst=/etc/machine-id,readonly`]
          : []),
        '-e',
        `TZ=${vm.timezone || 'UTC'}`,
        '-e',
        `LANG=${vm.locale || 'en_US.UTF-8'}`,
        '--entrypoint',
        'python3',
        image,
        '/slot/bin/runner.py',
      ],
      90000,
    )
  }
  info = await inspectManagedContainer(vm)
  if (!info?.running) throw containerError('container_start_failed')
  const runtime = {
    ...vm.runtime,
    type: 'docker',
    container: vm.container_name,
    container_id: info.id,
    stopped: false,
    worker_run_dir: paths(root, vm.id).run,
    worker_token_file: path.join(paths(root, vm.id).run, 'internal.token'),
    codex_kernel_socket: path.join(paths(root, vm.id).run, 'codex-kernel.sock'),
    observed_at: info.observed_at,
  }
  patchVmRecord(root, vm.id, { runtime, status: 'running' })
  // Reconcile a crash after docker run but before the runtime record was saved.
  // A retry of an already active assignment must leave its guest kernel running.
  if (!wasRunning || !vm.runtime?.container_id) await command(root, vm, false)
  return { ok: true, runtime }
}
async function command(root, vm, enabled, { restart = false } = {}) {
  const p = paths(root, vm.id)
  let previous
  try {
    previous = JSON.parse(fs.readFileSync(p.control, 'utf8'))
  } catch {}
  let stateBefore
  try {
    stateBefore = JSON.parse(fs.readFileSync(path.join(p.run, 'container-state.json'), 'utf8'))
  } catch {}
  const revision =
    !restart && !stateBefore?.failed && previous?.enabled === enabled ? previous.revision : crypto.randomUUID()
  atomicWriteJson(p.control, { revision, enabled }, { mode: 0o600 })
  const until = Date.now() + 10000
  while (Date.now() < until) {
    let state
    try {
      state = JSON.parse(fs.readFileSync(path.join(p.run, 'container-state.json'), 'utf8'))
    } catch {}
    if (
      state?.revision === revision &&
      !state.failed &&
      state.running === enabled &&
      state.observed_at > Date.now() / 1000 - 2
    )
      return
    if (state?.revision === revision && state.failed) throw containerError('kernel_failed', '槽位容器内核启动失败', 503)
    await delay(100)
  }
  throw containerError('kernel_control_timeout', '等待槽位内核状态超时', 503)
}
export async function ensureManagedKernel(exec, { internal = false } = {}) {
  const root = path.dirname(path.dirname(path.dirname(exec.homeDir)))
  const id = exec.vmId
  const taskKey = key(root, id)
  const vm = assertManagedWritable(root, exec.vm)
  if (!internal && mutations.has(taskKey)) throw containerError('slot_busy')
  if (starting.has(taskKey)) return starting.get(taskKey)
  const task = (async () => {
    const info = await inspectManagedContainer(vm)
    if (!info?.running) throw containerError('container_stopped', '槽位容器未运行', 503)
    const credential = path.join(paths(root, id).dir, 'codex-credentials.json')
    if (!fs.existsSync(credential)) throw containerError('no_credential')
    writeManagedConfig(root, vm)
    await command(root, vm, true)
    for (let i = 0; i < 60; i++) {
      const health = await codexKernelHealth(exec, { timeoutMs: 500 }).catch(() => null)
      if (health?.ok || health?.status === 200) return { ok: true, health, container: info }
      await delay(100)
    }
    throw containerError('health_timeout', '容器内 GPT 内核健康检查超时', 503)
  })()
  starting.set(taskKey, task)
  try {
    return await task
  } finally {
    if (starting.get(taskKey) === task) starting.delete(taskKey)
  }
}
export async function withManagedMaintenance(root, vm, fn, { deleting = false, restore = true } = {}) {
  const taskKey = key(root, vm.id)
  return withVmLock(taskKey, async () => {
    const current = getVm(root, vm.id)
    if (!current || current.assignment_id !== vm.assignment_id)
      throw containerError('slot_not_found', '槽位不存在', 404)
    if (!deleting && current.status === 'deleting') throw containerError('slot_deleting')
    mutations.add(taskKey)
    blockOpenAISlot(vm.id, true)
    try {
      if (deleting)
        patchVmRecord(root, vm.id, { status: 'deleting', schedulable: false, schedule_disabled_reason: 'deleting' })
      if (!deleting) {
        const until = Date.now() + 30000
        while (openAIRuntimeSignals(vm.id).inFlight > 0) {
          if (Date.now() >= until) throw containerError('slot_busy', '槽位仍有请求，稍后重试')
          await delay(100)
        }
        await starting.get(taskKey)?.catch(() => {})
      }
      const info = await inspectManagedContainer(current)
      // DELETE immediately removes the owned container, including active work.
      // It must not add a drain phase or depend on the guest controller replying.
      if (info?.running && !deleting) await command(root, current, false)
      const result = await fn(current, info)
      const saved = getVm(root, vm.id)
      if (restore && !deleting && saved?.status === 'running' && saved.schedulable) {
        await ensureManagedKernel(managedExec(root, saved), { internal: true })
      }
      return result
    } finally {
      mutations.delete(taskKey)
      const saved = getVm(root, vm.id)
      if (saved && saved.status !== 'deleting') blockOpenAISlot(vm.id, false)
    }
  })
}
export async function deleteManagedContainer(root, vm, finalize = () => {}) {
  return withManagedMaintenance(
    root,
    vm,
    async (current, info) => {
      if (info) {
        await docker(['rm', '-f', info.id])
        if (await inspectManagedContainer(current)) throw containerError('container_delete_failed')
      }
      fs.rmSync(paths(root, vm.id).dir, { recursive: true, force: true })
      fs.rmSync(path.join(root, 'vms', `${vm.id}-chat.json`), { force: true })
      await finalize(current)
      return { ok: true }
    },
    { deleting: true },
  )
}
export async function stopManagedContainer(root, vm) {
  return withManagedMaintenance(
    root,
    vm,
    async (current, info) => {
      if (info?.running) await docker(['stop', info.id])
      patchVmRecord(root, vm.id, { status: 'stopped' })
      return { ok: true }
    },
    { restore: false },
  )
}
export function managedExec(root, vm) {
  return { vm, vmId: vm.id, homeDir: path.join(root, 'vms', vm.id, 'cli-home') }
}
