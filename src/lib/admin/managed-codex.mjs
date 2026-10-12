import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { atomicWriteJson, isValidVmId, withVmLock } from '../vm/vm-file.mjs'
import { getVm, summarizeVm, patchVmRecord, clearActiveVm, getActiveVmId } from '../vm/vm-registry.mjs'
import { removeVmFromDb, clearActiveVmFromDb } from '../vm/vm-db-sync.mjs'
import { OS_CATALOG } from '../vm/os-catalog.mjs'
import { resolveMachineSpec } from '../vm/machine-spec.mjs'
import { generateWorkstationFingerprint } from '../identity/workstation-fingerprint.mjs'
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
export async function createManagedCodex(root, body, routing = {}) {
  const assignment = String(body.assignment_id || '')
  if (!/^[a-zA-Z0-9:_-]{8,200}$/.test(assignment))
    throw containerError('invalid_assignment', '缺少稳定的账号轮次标识', 400)
  const id = `space-${crypto.createHash('sha256').update(assignment).digest('hex').slice(0, 24)}`
  return withVmLock(path.join(root, 'vms', `${id}.json`), async () => {
    if (fs.existsSync(tombstonePath(root, id)))
      throw containerError('assignment_deleted', '该账号轮次已删除，不能重复创建')
    let vm = getVm(root, id)
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
      if (
        body.platform !== 'openai' ||
        body.runtime_type !== 'docker' ||
        body.node_id ||
        body.proxy_id !== 'px-local'
      ) {
        throw containerError('invalid_runtime', '集成槽位必须为本机 GPT Docker，使用本地出口', 400)
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
        execution_mode: 'docker_per_slot',
        container_name: accountContainerName(email, id),
        pool_id: poolId || null,
        platform: 'openai',
        family: 'codex',
        codex_kernel: true,
        kernel,
        locale,
        region: String(body.region || ''),
        runtime: { type: 'docker' },
        machine: resolveMachineSpec({ config: routing.vm, overrides: body.machine, runtime: 'docker' }),
        fingerprint: generateWorkstationFingerprint({ id, kernel, locale }),
        proxy: { id: 'px-local', scheme: 'local', host: 'local' },
        policy: {},
        codex: {},
        status: 'creating',
        schedulable: false,
        schedule_manual: true,
        schedule_disabled_reason: 'no_credential',
        created_at: now,
        updated_at: now,
      }
      fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
      atomicWriteJson(path.join(root, 'vms', `${id}.json`), vm, { mode: 0o600 })
    }
    if (vm.status === 'deleting') throw containerError('slot_deleting')
    const observed = await inspectManagedContainer(vm)
    if (!observed?.running) await startManagedContainer(vm, root, { routing })
    return {
      vm: summarizeVm(getVm(root, id), root, routing),
      container: await inspectManagedContainer(getVm(root, id)),
    }
  })
}

// Called only after the normal panel authentication, role and tenant checks.
export async function handleManagedCodex({ req, res, url, cfg, routing, readBody, json }) {
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
      })
      return json(res, 200, { ok: true, data: { deleted: id } })
    }
    if (req.method === 'DELETE' && !action && fs.existsSync(tombstonePath(root, id))) {
      const tombstone = JSON.parse(fs.readFileSync(tombstonePath(root, id), 'utf8'))
      if (req.headers?.['x-space-assignment'] && req.headers['x-space-assignment'] !== tombstone.assignment_id) {
        return json(res, 409, { ok: false, error: { code: 'assignment_conflict' } })
      }
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
        fs.rmSync(path.join(root, 'vms', `${id}.json`), { force: true })
      })
      return json(res, 200, { ok: true, data: { deleted: id } })
    }
    if (req.method === 'POST' && action === 'schedulable') {
      const body = await readBody(req, 8192)
      if (typeof body.schedulable !== 'boolean')
        throw containerError('invalid_schedule', 'schedulable 必须为布尔值', 400)
      // Persist suspension before draining, including when a request outlives the drain timeout.
      if (!body.schedulable)
        patchVmRecord(root, id, { schedulable: false, schedule_manual: true, schedule_disabled_reason: 'manual' })
      await withManagedMaintenance(root, vm, async (current) => {
        if (body.schedulable) {
          await ensureManagedKernel(managedExec(root, current), { internal: true })
          if (current.pool_id) vmPoolsFor(getDb()).addMember(current.pool_id, id)
        }
        patchVmRecord(root, id, {
          schedulable: body.schedulable,
          schedule_manual: true,
          schedule_disabled_reason: body.schedulable ? null : 'manual',
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
