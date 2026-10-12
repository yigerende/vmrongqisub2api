import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { accountContainerName, assertManagedWritable, writeManagedConfig } from '../../src/lib/vm/codex-container.mjs'
import {
  createManagedCodex,
  handleManagedCodex,
  reconcileManagedCodexProxies,
} from '../../src/lib/admin/managed-codex.mjs'
import { ProxyPool } from '../../src/lib/vm/proxy-pool.mjs'
import { getVm, bindVmProxy } from '../../src/lib/vm/vm-registry.mjs'
import { startVmRuntime, stopVmRuntime, destroyVmRuntime } from '../../src/lib/vm/vm-runtime.mjs'

function environment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'space-proxy-'))
  const proxyPool = new ProxyPool({ dataDir: path.join(root, 'data') })
  proxyPool.ensureLocal()
  t.after(() => {
    proxyPool.stopScheduler()
    proxyPool.db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, proxyPool }
}

function input() {
  return {
    assignment_id: `space-${crypto.randomBytes(24).toString('hex')}`,
    account_email: 'account@example.com',
    platform: 'openai',
    runtime_type: 'docker',
    proxy_id: 'px-local',
  }
}

function assignmentId(body) {
  return `space-${crypto.createHash('sha256').update(body.assignment_id).digest('hex').slice(0, 24)}`
}

function legacySlot(root, id, extra = {}) {
  const vm = {
    id,
    execution_mode: 'docker_per_slot',
    platform: 'openai',
    status: 'running',
    schedulable: true,
    schedule_manual: true,
    proxy: { id: 'px-local', scheme: 'local', host: 'local' },
    runtime: { type: 'docker', container_id: `container-${id}` },
    fingerprint: { device_id: `device-${id}` },
    ...extra,
  }
  fs.mkdirSync(path.join(root, 'vms'), { recursive: true })
  fs.writeFileSync(path.join(root, 'vms', `${id}.json`), JSON.stringify(vm))
  return vm
}

function failDocker(t, root) {
  const previous = process.env.KIN_DOCKER_BIN
  process.env.KIN_DOCKER_BIN = path.join(root, 'nonexistent-docker')
  t.after(() => {
    if (previous === undefined) delete process.env.KIN_DOCKER_BIN
    else process.env.KIN_DOCKER_BIN = previous
  })
}

test('account names are Docker-safe and a new cycle has a unique name', () => {
  const email = 'A+Name@Example.com'
  const a = accountContainerName(email, 'cycle1')
  assert.match(a, /^kin-a-name-example-com-[a-f0-9]{12}$/)
  assert.equal(a, accountContainerName(email, 'cycle1'))
  assert.notEqual(a, accountContainerName(email, 'cycle2'))
})

test('strict slots cannot fall through to legacy Docker lifecycle', () => {
  const vm = { id: 'space-fixture', execution_mode: 'docker_per_slot' }
  for (const fn of [startVmRuntime, stopVmRuntime, destroyVmRuntime]) assert.equal(fn(vm).ok, false)
})

test('deleting an ambiguous create releases only its reservation and prevents resurrection', async (t) => {
  const { root, proxyPool } = environment(t)
  const assignment = `space-${crypto.randomBytes(24).toString('hex')}`
  const id = `space-${crypto.createHash('sha256').update(assignment).digest('hex').slice(0, 24)}`
  proxyPool.bind('px-local', id)
  proxyPool.bind('px-local', 'unrelated-slot')
  let response
  const invoke = async (expected = assignment) =>
    handleManagedCodex({
      req: { method: 'DELETE', headers: { 'x-space-assignment': expected } },
      res: {},
      url: new URL(`http://localhost/api/panel/vms/${id}`),
      cfg: { paths: { project: root } },
      proxyPool,
      json: (_, status, body) => {
        response = { status, body }
        return true
      },
    })
  await invoke()
  assert.equal(response.status, 200)
  assert.equal(proxyPool.getProxyForVm(id), null)
  assert.equal(proxyPool.getProxyForVm('unrelated-slot').id, 'px-local')
  await invoke()
  assert.equal(response.status, 200)
  await invoke('wrong-cycle')
  assert.equal(response.status, 409)
  await assert.rejects(createManagedCodex(root, { assignment_id: assignment }), { code: 'assignment_deleted' })
  assert.throws(() => assertManagedWritable(root, { id, assignment_id: assignment }), { code: 'slot_unavailable' })
})

test('create refuses an unavailable local proxy before creating a slot or touching Docker', async (t) => {
  for (const state of ['missing', 'disabled', 'full']) {
    await t.test(state, async (t) => {
      const { root, proxyPool } = environment(t)
      proxyPool.importLines('127.0.0.1:1080') // An alternate exit must never be selected.
      if (state === 'missing') proxyPool.remove('px-local')
      if (state === 'disabled') proxyPool.setEnabled('px-local', false)
      if (state === 'full') {
        proxyPool.updateConfig({ bind_limit: 1 })
        proxyPool.bind('px-local', 'existing-slot')
      }
      const body = input()
      await assert.rejects(createManagedCodex(root, body, {}, proxyPool), {
        code: { missing: 'proxy_not_found', disabled: 'proxy_disabled', full: 'proxy_bind_limit' }[state],
      })
      assert.equal(getVm(root, assignmentId(body)), null)
      assert.equal(proxyPool.getProxyForVm(assignmentId(body)), null)
      if (state === 'full') assert.equal(proxyPool.getProxyForVm('existing-slot').id, 'px-local')
    })
  }
})

test('an interrupted Docker create keeps one durable local binding for the same assignment', async (t) => {
  const { root, proxyPool } = environment(t)
  failDocker(t, root)
  const body = input()
  const id = assignmentId(body)
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(createManagedCodex(root, body, {}, proxyPool), { code: 'docker_failed' })
    assert.equal(getVm(root, id).proxy.id, 'px-local')
    assert.equal(getVm(root, id).proxy_cli_enabled, true)
    assert.equal(getVm(root, id).schedulable, false)
    const reopened = new ProxyPool({ db: proxyPool.db })
    assert.deepEqual(reopened.snapshot().proxies.find((p) => p.id === 'px-local').bound_vm_ids, [id])
  }
})

test('concurrent pushes balance current counts only across selected available proxies and pin retries', async (t) => {
  const { root, proxyPool } = environment(t)
  failDocker(t, root)
  const [a, b, disabled] = proxyPool.importLines('10.0.0.1:1080\n10.0.0.2:1080\n10.0.0.3:1080').items.map((p) => p.id)
  proxyPool.bind(a, 'existing-a')
  proxyPool.bind(a, 'existing-b')
  proxyPool.setEnabled(disabled, false)
  const bodies = Array.from({ length: 6 }, () => ({ ...input(), proxy_ids: [a, a, b, disabled, 'missing'] }))
  await Promise.all(
    bodies.map((body) => assert.rejects(createManagedCodex(root, body, {}, proxyPool), { code: 'docker_failed' })),
  )
  const proxies = proxyPool.snapshot().proxies
  assert.equal(proxies.find((p) => p.id === a).bound_count, 4)
  assert.equal(proxies.find((p) => p.id === b).bound_count, 4)
  assert.equal(proxies.find((p) => p.id === 'px-local').bound_count, 0)
  const first = getVm(root, assignmentId(bodies[0]))
  assert.equal(first.proxy.id, b, 'first push must select the uniquely least-bound proxy')
  await assert.rejects(createManagedCodex(root, { ...bodies[0], proxy_ids: ['px-local'] }, {}, proxyPool), {
    code: 'docker_failed',
  })
  assert.equal(getVm(root, first.id).proxy.id, b, 'ambiguous retries must keep the original exit')
  assert.equal(proxyPool.snapshot().proxies.find((p) => p.id === b).bound_count, 4)
})

test('unavailable selected proxies never fall back to local; empty selection uses local', async (t) => {
  const { root, proxyPool } = environment(t)
  failDocker(t, root)
  const selected = proxyPool.importLines('10.0.0.1:1080').items[0].id
  proxyPool.updateConfig({ bind_limit: 1 })
  proxyPool.bind(selected, 'full-slot')
  const body = { ...input(), proxy_ids: [selected, 'missing'] }
  await assert.rejects(createManagedCodex(root, body, {}, proxyPool), { code: 'proxy_unavailable' })
  assert.equal(getVm(root, assignmentId(body)), null)
  await assert.rejects(createManagedCodex(root, { ...body, proxy_ids: 'bad' }, {}, proxyPool), {
    code: 'invalid_proxy_ids',
  })
  await assert.rejects(createManagedCodex(root, { ...body, proxy_ids: [] }, {}, proxyPool), { code: 'docker_failed' })
  assert.equal(getVm(root, assignmentId(body)).proxy.id, 'px-local')
})

test('guest kernel uses persisted SOCKS credentials, requires the proxy, and refuses an unbound exit', (t) => {
  const { root, proxyPool } = environment(t)
  const vm = legacySlot(root, 'space-config')
  writeManagedConfig(root, vm)
  const configFile = path.join(root, 'vms', vm.id, 'run', 'codex-kernel.json')
  let config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.equal(config.proxy_url, '')
  assert.equal(config.proxy_required, false)
  const proxy = proxyPool.importLines('socks5://a%40b:p%3Ass@10.0.0.1:1080').items[0]
  proxyPool.bind(proxy.id, vm.id)
  bindVmProxy(root, vm.id, proxyPool.getProxyForVm(vm.id))
  writeManagedConfig(root, vm) // stale caller snapshot must not restore direct egress
  config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.equal(config.proxy_url, 'socks5h://a%40b:p%3Ass@10.0.0.1:1080')
  assert.equal(config.proxy_required, true)
  bindVmProxy(root, vm.id, null)
  assert.throws(() => writeManagedConfig(root, vm), { code: 'proxy_required' })
})

test('failure to save a new slot releases its reservation without unbinding other slots', async (t) => {
  const { root, proxyPool } = environment(t)
  proxyPool.bind('px-local', 'unrelated-slot')
  fs.writeFileSync(path.join(root, 'vms'), 'not a directory')
  const body = input()
  await assert.rejects(createManagedCodex(root, body, {}, proxyPool), { code: 'EEXIST' })
  assert.equal(proxyPool.getProxyForVm(assignmentId(body)), null)
  assert.equal(proxyPool.getProxyForVm('unrelated-slot').id, 'px-local')
})

test('a create retry cannot replace an operator-selected exit', async (t) => {
  const { root, proxyPool } = environment(t)
  const body = input()
  const vm = legacySlot(root, assignmentId(body), {
    assignment_id: body.assignment_id,
    account_email: body.account_email,
  })
  const other = proxyPool.importLines('127.0.0.1:1080').items[0].id
  proxyPool.bind(other, vm.id)
  await assert.rejects(createManagedCodex(root, body, {}, proxyPool), { code: 'proxy_binding_conflict' })
  assert.equal(proxyPool.getProxyForVm(vm.id).id, other)
  assert.deepEqual(getVm(root, vm.id), vm)
})

test('upgrade repairs local bindings without changing containers, fingerprints or scheduling', (t) => {
  const { root, proxyPool } = environment(t)
  const slots = [
    legacySlot(root, 'space-active'),
    legacySlot(root, 'space-paused', { schedulable: false, schedule_disabled_reason: 'manual' }),
  ]
  assert.deepEqual(reconcileManagedCodexProxies(root, proxyPool), {
    repaired: slots.map((vm) => vm.id),
    failed: [],
  })
  for (const vm of slots) {
    const saved = getVm(root, vm.id)
    assert.equal(proxyPool.getProxyForVm(vm.id).id, 'px-local')
    assert.equal(saved.proxy_cli_enabled, true)
    for (const field of [
      'runtime',
      'fingerprint',
      'status',
      'schedulable',
      'schedule_manual',
      'schedule_disabled_reason',
    ])
      assert.deepEqual(saved[field], vm[field], field)
  }
  assert.deepEqual(reconcileManagedCodexProxies(root, proxyPool), { repaired: [], failed: [] })
  const reopened = new ProxyPool({ db: proxyPool.db })
  assert.equal(reopened.snapshot().proxies.find((p) => p.id === 'px-local').bound_count, 2)
  // A subsequent explicit panel unbind must survive another restart.
  proxyPool.unbindVm(slots[0].id)
  bindVmProxy(root, slots[0].id, null)
  assert.deepEqual(reconcileManagedCodexProxies(root, proxyPool), { repaired: [], failed: [] })
  assert.equal(proxyPool.getProxyForVm(slots[0].id), null)
})

test('upgrade leaves manual proxy changes, deleting slots and ordinary slots untouched', (t) => {
  const { root, proxyPool } = environment(t)
  const other = proxyPool.importLines('127.0.0.1:1080').items[0].id
  const slots = [
    legacySlot(root, 'space-unbound', { proxy: null }),
    legacySlot(root, 'space-alternate', { proxy: { id: other, scheme: 'socks5' } }),
    legacySlot(root, 'space-owned-elsewhere'),
    legacySlot(root, 'space-deleting', { status: 'deleting' }),
    legacySlot(root, 'vm-ordinary', { execution_mode: null }),
  ]
  proxyPool.bind(other, 'space-owned-elsewhere')
  assert.deepEqual(reconcileManagedCodexProxies(root, proxyPool), { repaired: [], failed: [] })
  assert.equal(proxyPool.getProxyForVm('space-owned-elsewhere').id, other)
  for (const vm of slots) assert.deepEqual(getVm(root, vm.id), vm)
})

test('upgrade reports local capacity/disabled failures without falling back or changing slot state', async (t) => {
  for (const state of ['disabled', 'full']) {
    await t.test(state, (t) => {
      const { root, proxyPool } = environment(t)
      const vm = legacySlot(root, 'space-pending')
      proxyPool.importLines('127.0.0.1:1080')
      if (state === 'disabled') proxyPool.setEnabled('px-local', false)
      else {
        proxyPool.updateConfig({ bind_limit: 1 })
        proxyPool.bind('px-local', 'existing-slot')
      }
      assert.deepEqual(reconcileManagedCodexProxies(root, proxyPool), {
        repaired: [],
        failed: [{ vm_id: vm.id, error: state === 'disabled' ? 'proxy_disabled' : 'proxy_bind_limit' }],
      })
      assert.deepEqual(getVm(root, vm.id), vm)
      assert.equal(proxyPool.getProxyForVm(vm.id), null)
      if (state === 'disabled')
        assert.equal(proxyPool.snapshot().proxies.find((p) => p.id === 'px-local').enabled, false)
    })
  }
})
