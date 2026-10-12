import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { handleCodexProtocol, pickCodexCandidates } from '../../src/lib/protocol/handle-codex.mjs'
import { getVm, listVms } from '../../src/lib/vm/vm-registry.mjs'
import { changeVmQualitySchedule } from '../../src/lib/admin/vm-quality-schedule.mjs'
import { runVmQualityProbe } from '../../src/lib/admin/vm-quality-probe.mjs'
import { DEFAULT_QUALITY_CONFIG, evaluateQuality } from '../../src/lib/admin/vm-quality-config.mjs'

const targetId = 'vm-z-target'
const otherId = 'vm-a-other'
const event = (data) => `data: ${JSON.stringify(data)}\n\n`

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-pinned-probe-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function seed(
  root,
  id,
  { status = 'running', credentials = { access_token: 'test-at', refresh_token: 'test-rt' } } = {},
) {
  const dir = path.join(root, 'vms', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      platform: 'openai',
      family: 'codex',
      execution_mode: 'docker_per_slot',
      status,
      schedulable: true,
      proxy: { id: 'px-local', scheme: 'local', host: 'local' },
    }),
  )
  fs.writeFileSync(
    path.join(dir, 'codex-credentials.json'),
    JSON.stringify({ accounts: credentials ? [credentials] : [] }),
  )
}

function pick(root, pin) {
  return pickCodexCandidates(
    root,
    { apiKeyKind: 'master', headers: pin ? { 'x-kin-vm': pin } : {} },
    { body: { model: 'gpt-5.4' } },
  )
}

async function gateway(t, projectRoot, failure = null) {
  const seen = { config: [], ensure: [], hop: [] }
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks))
      assert.equal(req.headers.authorization, 'Bearer test-master-key')
      req.apiKeyKind = 'master'
      await handleCodexProtocol({
        req,
        res,
        protocol: 'openai.responses',
        ctx: { path: req.url, body },
        inbound: body,
        projectRoot,
        logBag: {},
        stats: { errors: 0, requests: 0, by_route: {} },
        json: (response, status, payload) => {
          response.writeHead(status, { 'content-type': 'application/json' })
          response.end(JSON.stringify(payload))
        },
        writeSSEHeaders: (response) => response.writeHead(200, { 'content-type': 'text/event-stream' }),
        ops: {
          writeCodexKernelConfig: (_root, vm) => seen.config.push(vm.id),
          ensureCodexKernel: async (exec) => {
            seen.ensure.push({ id: exec.vmId, mode: exec.vm.execution_mode })
            return { ok: true }
          },
          streamCodexKernel: async ({ exec, onEvent }) => {
            seen.hop.push(exec.vmId)
            if (failure) return failure
            await onEvent(event({ type: 'response.output_text.delta', delta: '21' }))
            await onEvent(event({ type: 'response.completed', response: { status: 'completed', model: 'gpt-5.4' } }))
            return { ok: true, status: 200, terminalState: 'verified' }
          },
        },
      })
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: error.message } }))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(resolve))
  })
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, seen }
}

async function probe(root, baseUrl) {
  return runVmQualityProbe({
    vm: getVm(root, targetId),
    config: DEFAULT_QUALITY_CONFIG,
    question: DEFAULT_QUALITY_CONFIG.questions[0],
    apiKey: 'test-master-key',
    baseUrl,
  })
}

test('pinned Docker slots derive credential presence from the account file, like ordinary routing', (t) => {
  const root = fixture(t)
  for (const credentials of [{ access_token: 'test-at' }, { refresh_token: 'test-rt' }]) {
    seed(root, targetId, { credentials })
    assert.equal(getVm(root, targetId).has_token, undefined)
    assert.deepEqual(pick(root).ids, [targetId])
    const pinned = pick(root, targetId)
    assert.equal(pinned.error, undefined)
    assert.deepEqual(pinned.ids, [targetId])
    assert.equal(getVm(root, targetId).has_token, undefined, 'admission must not rewrite the slot record')
  }
})

test('quality loopback reaches the pinned Docker kernel and leaves scheduling unchanged', async (t) => {
  const root = fixture(t)
  seed(root, targetId)
  seed(root, otherId)
  const before = getVm(root, targetId)
  const { baseUrl, seen } = await gateway(t, root)
  const result = await probe(root, baseUrl)
  assert.equal(result.ok, true, result.error?.message)
  assert.equal(result.complete, true)
  assert.equal(evaluateQuality(DEFAULT_QUALITY_CONFIG, DEFAULT_QUALITY_CONFIG.questions[0], result).status, 'normal')
  assert.deepEqual(seen.config, [targetId])
  assert.deepEqual(seen.ensure, [{ id: targetId, mode: 'docker_per_slot' }])
  assert.deepEqual(seen.hop, [targetId])
  assert.deepEqual(getVm(root, targetId), before)
})

test('stopped and unauthorised pinned containers stay unavailable and report the actual gate', async (t) => {
  const root = fixture(t)
  seed(root, otherId)
  const { baseUrl, seen } = await gateway(t, root)
  for (const state of [{ status: 'stopped' }, { credentials: null }]) {
    seed(root, targetId, state)
    assert.equal(pick(root, targetId).error, 'slot_unavailable')
    const result = await probe(root, baseUrl)
    assert.equal(result.ok, false)
    assert.match(result.error?.message, /槽位.*未运行.*未授权/)
    assert.doesNotMatch(result.error?.message, /no Codex kernel VM is configured/)
    assert.equal(evaluateQuality(DEFAULT_QUALITY_CONFIG, DEFAULT_QUALITY_CONFIG.questions[0], result).status, 'error')
  }
  assert.deepEqual(seen.config, [])
  assert.deepEqual(seen.ensure, [])
  assert.deepEqual(seen.hop, [])
})

test('quality-paused Docker slot continues real pinned recovery probes without enabling normal scheduling', async (t) => {
  const root = fixture(t)
  seed(root, targetId)
  changeVmQualitySchedule(root, listVms(root)[0], false)
  assert.deepEqual(pick(root).ids, [])
  const before = getVm(root, targetId)
  const { baseUrl, seen } = await gateway(t, root)
  const result = await probe(root, baseUrl)
  assert.equal(result.ok, true, result.error?.message)
  assert.deepEqual(seen.hop, [targetId])
  assert.deepEqual(getVm(root, targetId), before)
})

test('failed pinned probes never substitute another account and remain yellow', async (t) => {
  const root = fixture(t)
  seed(root, targetId)
  seed(root, otherId)
  const { baseUrl, seen } = await gateway(t, root, {
    ok: false,
    status: 401,
    body: { error: { code: 'upstream_auth', message: 'OAuth rejected by upstream' } },
  })
  const result = await probe(root, baseUrl)
  assert.equal(result.ok, false)
  assert.equal(result.error?.message, 'OAuth rejected by upstream')
  assert.deepEqual(seen.hop, [targetId])
  assert.equal(evaluateQuality(DEFAULT_QUALITY_CONFIG, DEFAULT_QUALITY_CONFIG.questions[0], result).status, 'error')
})
