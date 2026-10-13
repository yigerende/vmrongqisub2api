import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { atomicWriteJson, invalidateVmSlotReadCache, isValidVmId, withVmLock } from '../vm/vm-file.mjs'
import {
  getVm,
  listVms,
  summarizeVm,
  patchVmRecord,
  clearActiveVm,
  getActiveVmId,
  bindVmProxy,
  setVmSchedulable,
} from '../vm/vm-registry.mjs'
import { removeVmFromDb, clearActiveVmFromDb } from '../vm/vm-db-sync.mjs'
import { OS_CATALOG } from '../vm/os-catalog.mjs'
import { resolveMachineSpec } from '../vm/machine-spec.mjs'
import { generateWorkstationFingerprint, takenFingerprintKeys } from '../identity/workstation-fingerprint.mjs'
import { parseCodexImportPayload, upsertCodexAccount, readCodexAccounts } from '../vm/codex-slot.mjs'
import { vmPoolsFor } from './vm-pools.mjs'
import { getDb } from '../db/database.mjs'
import {
  managedCodex,
  accountContainerName,
  containerError,
  startManagedContainer,
  deleteManagedContainer,
  inspectManagedContainer,
  withManagedMaintenance,
  ensureManagedKernel,
  managedExec,
  stopManagedContainer,
} from '../vm/codex-container.mjs'

const tombstonePath = (root, id) => path.join(root, 'data', 'space-deleted', `${id}.json`)
function boundProxy(proxyPool, id) {
  return proxyPool.snapshot().proxies.find((proxy) => proxy.bound_vm_ids.includes(id))
}

function bindManagedProxy(proxyPool, id, proxyId) {
  if (!proxyPool) throw containerError('proxy_pool_unavailable', '代理池不可用', 503)
  const existing = boundProxy(proxyPool, id)
  if (existing && existing.id !== proxyId)
    throw containerError('proxy_binding_conflict', '槽位已绑定其他代理，请先检查出口配置')
  // Use the same binding limits and enabled checks as panel-created slots.
  // Never fall back to an arbitrary proxy when the requested exit is unavailable.
  const result = proxyPool.bind(proxyId, id)
  if (!result.ok) {
    const message =
      result.error === 'proxy_bind_limit'
        ? `代理绑定数已达上限（${result.max}），请调整代理池绑定上限或释放槽位`
        : `无法绑定代理：${result.error}`
    throw containerError(result.error, message)
  }
  return proxyPool.getProxyForVm(id)
}

function selectManagedProxy(proxyPool, body) {
  if (!proxyPool) throw containerError('proxy_pool_unavailable', '代理池不可用', 503)
  if (
    body.proxy_ids != null &&
    (!Array.isArray(body.proxy_ids) || body.proxy_ids.some((id) => typeof id !== 'string' || !id.trim()))
  )
    throw containerError('invalid_proxy_ids', '代理列表必须为代理 ID 数组', 400)
  const selected = new Set((body.proxy_ids || []).map((id) => id.trim()))
  if (!selected.size) return String(body.proxy_id || 'px-local').trim()
  const available = proxyPool
    .snapshot()
    .proxies.filter(
      (p) =>
        selected.has(p.id) &&
        p.enabled &&
        !p.blocked_reason &&
        !['dead', 'fail'].includes(p.status) &&
        Number.isInteger(p.bound_count) &&
        p.bound_count >= 0 &&
        p.bound_count < p.bind_limit,
    )
  if (!available.length) throw containerError('proxy_unavailable', '所选代理均不可用或已达到绑定上限，已停止推送')
  const min = Math.min(...available.map((p) => p.bound_count))
  const candidates = available.filter((p) => p.bound_count === min)
  return candidates[crypto.randomInt(candidates.length)].id
}

// Repair old Space slots that recorded px-local only in vm.json. This runs before
// serving requests and touches binding metadata only, never the container/kernel.
export function reconcileManagedCodexProxies(root, proxyPool) {
  const result = { repaired: [], failed: [] }
  for (const vm of listVms(root)) {
    if (!managedCodex(vm) || vm.status === 'deleting' || vm.proxy?.id !== 'px-local') continue
    // A panel unbind clears vm.proxy; an existing binding (even disabled) belongs
    // to the operator. Neither should be overridden during an upgrade.
    if (boundProxy(proxyPool, vm.id)) continue
    try {
      bindVmProxy(root, vm.id, bindManagedProxy(proxyPool, vm.id, 'px-local'))
      result.repaired.push(vm.id)
    } catch (error) {
      result.failed.push({ vm_id: vm.id, error: error.code || error.message })
    }
  }
  return result
}

export async function createManagedCodex(root, body, routing = {}, proxyPool) {
  const assignment = String(body.assignment_id || '')
  if (!/^[a-zA-Z0-9:_-]{8,200}$/.test(assignment))
    throw containerError('invalid_assignment', '缺少稳定的账号轮次标识', 400)
  const id = `space-${crypto.createHash('sha256').update(assignment).digest('hex').slice(0, 24)}`
  return withVmLock(path.join(root, 'vms', `${id}.json`), async () => {
    if (fs.existsSync(tombstonePath(root, id)))
      throw containerError('assignment_deleted', '该账号轮次已删除，不能重复创建')
    let vm = getVm(root, id)
    const isNew = !vm
    if (vm && (!managedCodex(vm) || vm.assignment_id !== assignment)) throw containerError('assignment_conflict')
    if (
      vm &&
      (String(body.account_email || '')
        .trim()
        .toLowerCase() !== vm.account_email.toLowerCase() ||
        String(body.pool_id || '') !== String(vm.pool_id || ''))
    )
      throw containerError('assignment_conflict', '同一轮次不能更换账号或账号池')
    if (!vm) {
      const email = String(body.account_email || '').trim()
      if (!email || email.length > 254) throw containerError('invalid_email', '需要账号邮箱', 400)
      const runtime = body.runtime_type || 'docker'
      const executionMode = runtime === 'kvm' ? 'kvm_per_slot' : 'docker_per_slot'
      if (
        body.platform !== 'openai' ||
        !['docker', 'kvm'].includes(runtime) ||
        body.node_id ||
        (body.execution_mode && body.execution_mode !== executionMode)
      ) {
        throw containerError('invalid_runtime', '集成槽位必须为本机 GPT Docker 或 KVM，形态与执行模式必须一致', 400)
      }
      const kernel = body.kernel || 'ubuntu-24.04'
      if (!OS_CATALOG[kernel]) throw containerError('invalid_kernel', '系统不支持', 400)
      const locale = body.locale || 'en_US.UTF-8'
      if (!['en_US.UTF-8', 'zh_CN.UTF-8', 'ja_JP.UTF-8', 'C'].includes(locale))
        throw containerError('invalid_locale', '语言不支持', 400)
      const poolId = String(body.pool_id || '')
      const pool = poolId ? vmPoolsFor(getDb()).get(poolId) : null
      if (poolId && !pool?.enabled) throw containerError('pool_unavailable', '账号池不可用', 400)
      const now = new Date().toISOString()
      vm = {
        id,
        assignment_id: assignment,
        account_email: email,
        name: email,
        execution_mode: executionMode,
        container_name: accountContainerName(email, id),
        pool_id: poolId || null,
        platform: 'openai',
        family: 'codex',
        codex_kernel: true,
        kernel,
        locale,
        region: String(body.region || ''),
        runtime: { type: runtime },
        machine: resolveMachineSpec({ config: routing.vm, overrides: body.machine, runtime }),
        fingerprint: generateWorkstationFingerprint(
          { id, kernel, locale },
          { taken: takenFingerprintKeys(listVms(root)) },
        ),
        proxy: { id: selectManagedProxy(proxyPool, body) },
        policy: {},
        codex: {},
        status: 'creating',
        schedulable: false,
        schedule_manual: true,
        schedule_disabled_reason: 'no_credential',
        created_at: now,
        updated_at: now,
      }
    }
    if (vm.status === 'deleting') throw containerError('slot_deleting')
    if (!vm.proxy?.id) throw containerError('proxy_binding_conflict', '集成槽位已解绑代理，请先检查出口配置')
    // Selection and reservation are synchronous, before the first Docker await:
    // concurrent pushes from either Space instance see the updated binding count.
    // Existing assignments retain their exit even if candidates/counts changed.
    const proxy = bindManagedProxy(proxyPool, id, vm.proxy.id)
    vm.proxy = proxy
    vm.proxy_cli_enabled = true
    if (isNew) {
      try {
        fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
        atomicWriteJson(path.join(root, 'vms', `${id}.json`), vm, { mode: 0o600 })
      } catch (error) {
        proxyPool.unbindVm(id)
        throw error
      }
    }
    bindVmProxy(root, id, proxy)
    // Keep the slot and its reservation on a Docker failure so a retry resumes
    // the same assignment; DELETE releases both after container cleanup succeeds.
    await startManagedContainer(vm, root, { routing })
    return {
      vm: summarizeVm(getVm(root, id), root, routing),
      container: await inspectManagedContainer(getVm(root, id)),
    }
  })
}

// Called only after the normal panel authentication, role and tenant checks.
export async function handleManagedCodex({ req, res, url, cfg, routing, proxyPool, readBody, json }) {
  const root = cfg.paths.project
  const match = url.pathname.match(/^\/api\/panel\/vms\/([^/]+)(?:\/(.*))?$/)
  if (!match || !isValidVmId(match[1])) return false
  const id = match[1]
  const action = match[2] || ''
  const vm = getVm(root, id)
  if (!managedCodex(vm)) {
    const assignment = req.headers?.['x-space-assignment']
    if (
      !vm &&
      req.method === 'DELETE' &&
      !action &&
      typeof assignment === 'string' &&
      /^space-[a-f0-9]{48}$/.test(assignment) &&
      id === `space-${crypto.createHash('sha256').update(assignment).digest('hex').slice(0, 24)}`
    ) {
      await withVmLock(path.join(root, 'vms', `${id}.json`), () => {
        if (getVm(root, id)) throw containerError('slot_busy', '创建仍在进行，请重试删除')
        fs.mkdirSync(path.dirname(tombstonePath(root, id)), { recursive: true })
        atomicWriteJson(
          tombstonePath(root, id),
          { assignment_id: assignment, deleted_at: new Date().toISOString() },
          { mode: 0o600 },
        )
        proxyPool.unbindVm(id)
      })
      return json(res, 200, { ok: true, data: { deleted: id } })
    }
    if (req.method === 'DELETE' && !action && fs.existsSync(tombstonePath(root, id))) {
      const tombstone = JSON.parse(fs.readFileSync(tombstonePath(root, id), 'utf8'))
      if (req.headers?.['x-space-assignment'] && req.headers['x-space-assignment'] !== tombstone.assignment_id) {
        return json(res, 409, { ok: false, error: { code: 'assignment_conflict' } })
      }
      proxyPool.unbindVm(id)
      return json(res, 200, { ok: true, data: { deleted: id } })
    }
    return false
  }
  const expected = req.headers?.['x-space-assignment']
  if (expected && expected !== vm.assignment_id)
    return json(res, 409, { ok: false, error: { code: 'assignment_conflict' } })
  try {
    if (req.method === 'GET' && !action) {
      return json(res, 200, {
        ok: true,
        data: { vm: summarizeVm(vm, root, routing), container: await inspectManagedContainer(vm) },
      })
    }
    if (req.method === 'DELETE' && !action) {
      await deleteManagedContainer(root, vm, () => {
        getDb().prepare('DELETE FROM vm_pool_members WHERE vm_id = ?').run(id)
        if (getActiveVmId(root) === id) {
          clearActiveVm(root)
          clearActiveVmFromDb()
        }
        removeVmFromDb(id)
        fs.mkdirSync(path.dirname(tombstonePath(root, id)), { recursive: true })
        atomicWriteJson(
          tombstonePath(root, id),
          { assignment_id: vm.assignment_id, deleted_at: new Date().toISOString() },
          { mode: 0o600 },
        )
        proxyPool.unbindVm(id)
        fs.rmSync(path.join(root, 'vms', `${id}.json`), { force: true })
        invalidateVmSlotReadCache(root, id)
      })
      return json(res, 200, { ok: true, data: { deleted: id } })
    }
    if (req.method === 'POST' && action === 'schedulable') {
      const body = await readBody(req, 8192)
      if (typeof body.schedulable !== 'boolean')
        throw containerError('invalid_schedule', 'schedulable 必须为布尔值', 400)
      // Persist suspension before draining, including when a request outlives the drain timeout.
      if (!body.schedulable) setVmSchedulable(root, id, false, 'manual', { preserveStatus: true, source: 'manual' })
      await withManagedMaintenance(root, vm, async (current) => {
        if (body.schedulable) {
          await ensureManagedKernel(managedExec(root, current), { internal: true })
          if (current.pool_id) vmPoolsFor(getDb()).addMember(current.pool_id, id)
        }
        setVmSchedulable(root, id, body.schedulable, body.schedulable ? null : 'manual', {
          preserveStatus: true,
          source: 'manual',
        })
      })
      return json(res, 200, { ok: true, data: { id, schedulable: body.schedulable, in_flight: 0 } })
    }
    if (req.method === 'POST' && action === 'start') {
      const result = await withManagedMaintenance(root, vm, (current) =>
        startManagedContainer(current, root, { routing }),
      )
      return json(res, 200, { ok: true, data: result })
    }
    if (req.method === 'POST' && action === 'stop') {
      return json(res, 200, { ok: true, data: await stopManagedContainer(root, vm) })
    }
    if (req.method !== 'GET' && !['test-chat', 'openai-quota/refresh'].includes(action)) {
      throw containerError('managed_slot_operation', '集成槽位请通过推送、重新授权或删除管理')
    }
  } catch (error) {
    return json(res, error.status || 500, {
      ok: false,
      error: { code: error.code || 'managed_slot_failed', message: error.message },
    })
  }
  return false
}

export async function importManagedCodex(root, vm, body, routing) {
  return withManagedMaintenance(root, vm, async (current) => {
    const parsed = parseCodexImportPayload(body)
    if (!parsed.ok || !parsed.account.access_token || !parsed.account.refresh_token)
      throw containerError('invalid_credential', '需要完整的 Codex AT/RT', 400)
    if (parsed.account.email && parsed.account.email.toLowerCase() !== current.account_email.toLowerCase())
      throw containerError('account_mismatch', '凭证账号与槽位账号不匹配')
    const previous = readCodexAccounts(root, vm.id)[0]
    const fingerprint = crypto
      .createHash('sha256')
      .update(parsed.account.access_token + '\0' + parsed.account.refresh_token)
      .digest('hex')
    // Retrying a completed import must not overwrite tokens since rotated by the kernel.
    if (current.import_fingerprint !== fingerprint || !previous) {
      upsertCodexAccount(root, vm.id, parsed.account)
      patchVmRecord(root, vm.id, {
        import_fingerprint: fingerprint,
        codex: {
          has_access: true,
          has_refresh: true,
          email: parsed.account.email || current.account_email,
          chatgpt_account_id: parsed.account.chatgpt_account_id,
        },
      })
    }
    await ensureManagedKernel(managedExec(root, getVm(root, vm.id)), { internal: true })
    return { vm: summarizeVm(getVm(root, vm.id), root, routing) }
  })
}
