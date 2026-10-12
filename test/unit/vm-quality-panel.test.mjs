import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPanelHandler } from '../../src/lib/admin/panel-routes.mjs'
import { buildVmList } from '../../src/lib/admin/panel-api.mjs'

test('mounted quality routes require operator authentication and admin role', async () => {
  for (const role of ['admin', 'user', 'super', 'client']) {
    let reply
    let called = false
    const handler = createPanelHandler({
      cfg: { paths: { project: 'unused' } },
      requireAuth(req) {
        if (role === 'client') req.apiKeyKind = 'managed'
        else {
          req.panelUser = 'tester'
          req.panelRole = role
        }
        return true
      },
      qualityMonitor: {
        getConfig() {
          called = true
          return { model: 'gpt-5.4' }
        },
      },
      json: (_, status, body) => {
        reply = { status, body }
        return true
      },
    })
    await handler({ method: 'GET' }, {}, new URL('http://localhost/api/panel/vm-quality/settings'))
    assert.equal(reply.status, role === 'admin' ? 200 : 403)
    assert.equal(called, role === 'admin')
  }
})

test('VM list enrichment retains quality history for admins only', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-quality-panel-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'vms'))
  fs.writeFileSync(
    path.join(root, 'vms', 'vm-quality.json'),
    JSON.stringify({
      id: 'vm-quality',
      name: 'quality',
      platform: 'openai',
      status: 'stopped',
      proxy: { id: 'px-local', scheme: 'local' },
    }),
  )
  const quality = {
    enabled: true,
    running: false,
    next_at: null,
    history: [{ id: 1, status: 'normal', source: 'manual' }],
  }
  const args = { cfg: { paths: { project: root } }, qualityMonitor: { snapshot: () => quality } }
  const admin = await buildVmList({ ...args, role: 'admin' })
  assert.deepEqual(admin.data.items[0].quality, quality)
  const readOnly = await buildVmList({ ...args, role: 'super' })
  assert.equal(readOnly.data.items[0].quality, undefined)
})
