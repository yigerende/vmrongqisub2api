import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { SettingsRepo } from '../../src/lib/db/repos/settings-repo.mjs'
import { createRequestLimits, requestLimitScope } from '../../src/lib/admin/request-limits.mjs'
import { authorizePanelRoute } from '../../src/lib/admin/panel-acl.mjs'

function fixture(t, env = {}) {
  const db = createDatabase({ dbPath: ':memory:' })
  t.after(() => db.close())
  const settings = new SettingsRepo(db)
  let time = 1000
  const options = { settings, env, now: () => time }
  return {
    settings,
    options,
    limits: createRequestLimits(options),
    advance: (ms) => {
      time += ms
    },
  }
}
const enabled = { enabled: true, rpm: 60, burst: 2 }

test('API and panel default unlimited, including legacy capacity/refill-only environments', (t) => {
  const { limits } = fixture(t, { KIN_RATE_CAP: '1', KIN_RATE_REFILL: '0.1' })
  assert.deepEqual(limits.snapshot().api, { enabled: false, rpm: 6, burst: 1, source: 'environment' })
  assert.deepEqual(limits.snapshot().panel, { enabled: false, rpm: 60, burst: 60, source: 'default' })
  for (let i = 0; i < 1000; i++) {
    assert.equal(limits.allow('api', 'key-a'), true)
    assert.equal(limits.allow('panel', 'key-a'), true)
  }
})

test('buckets are independent per key and per scope, with fractional refill', (t) => {
  const f = fixture(t)
  f.limits.save({ api: enabled, panel: enabled })
  assert.equal(f.limits.allow('api', 'a'), true)
  assert.equal(f.limits.allow('api', 'a'), true)
  assert.equal(f.limits.allow('api', 'a'), false)
  assert.equal(f.limits.allow('api', 'b'), true)
  assert.equal(f.limits.allow('panel', 'a'), true)
  f.advance(500)
  assert.equal(f.limits.allow('api', 'a'), false)
  f.advance(500)
  assert.equal(f.limits.allow('api', 'a'), true)
  assert.equal(f.limits.allow('api', 'a'), false)
})

test('hot changes settle old refill and preserve consumed allowance on saves', (t) => {
  const f = fixture(t)
  f.limits.save({ api: enabled })
  f.limits.allow('api', 'a')
  f.limits.allow('api', 'a')
  f.advance(500)
  f.limits.save({ api: { ...enabled, rpm: 120 } })
  assert.equal(f.limits.allow('api', 'a'), false)
  f.advance(250)
  assert.equal(f.limits.allow('api', 'a'), true)
  f.limits.save({ panel: enabled })
  f.limits.save({ api: { ...enabled, rpm: 120 } })
  assert.equal(f.limits.allow('api', 'a'), false)
  f.limits.save({ api: { ...enabled, enabled: false } })
  for (let i = 0; i < 100; i++) assert.equal(f.limits.allow('api', 'a'), true)
  f.limits.save({ api: { ...enabled, burst: 1 } })
  assert.equal(f.limits.allow('api', 'a'), true)
  assert.equal(f.limits.allow('api', 'a'), false)
})

test('web config overrides explicit environment and survives service recreation; reset is scope-local', (t) => {
  const f = fixture(t, { KIN_RATE_ENABLED: '1', KIN_RATE_CAP: '10', KIN_RATE_REFILL: '2' })
  assert.equal(f.limits.snapshot().api.enabled, true)
  f.limits.save({ api: { ...enabled, enabled: false }, panel: enabled })
  const restarted = createRequestLimits(f.options)
  assert.deepEqual(restarted.snapshot(), f.limits.snapshot())
  const reset = restarted.save({ api: null })
  assert.deepEqual(reset.api, { enabled: true, rpm: 120, burst: 10, source: 'environment' })
  assert.deepEqual(reset.panel, { ...enabled, source: 'web' })
})

test('invalid or failed saves leave persisted config and active buckets unchanged', (t) => {
  const f = fixture(t)
  f.limits.save({ api: enabled })
  f.limits.allow('api', 'a')
  f.limits.allow('api', 'a')
  for (const patch of [
    null,
    [],
    {},
    { unknown: enabled },
    { api: [] },
    { api: { ...enabled, enabled: 'false' } },
    { api: { ...enabled, rpm: 0 } },
    { api: { ...enabled, rpm: Infinity } },
    { api: { ...enabled, burst: 0.5 } },
    { api: { ...enabled, burst: 1000001 } },
    { api: enabled, panel: { enabled: false } },
  ]) {
    assert.throws(() => f.limits.save(patch))
    assert.equal(f.limits.allow('api', 'a'), false)
    assert.deepEqual(createRequestLimits(f.options).snapshot(), f.limits.snapshot())
  }
  t.mock.method(f.settings, 'set', () => {
    throw new Error('disk full')
  })
  assert.throws(() => f.limits.save({ api: { ...enabled, enabled: false } }), /disk full/)
  assert.equal(f.limits.allow('api', 'a'), false)
})

test('management paths have their own scope and only admin may configure limits', () => {
  for (const url of ['/api/panel/vms', '/api/panel/request-limits?x=1', '/admin/models/refresh'])
    assert.equal(requestLimitScope(url), 'panel')
  for (const url of ['/v1/models', '/v1/responses', '/responses', '/api/panel-other'])
    assert.equal(requestLimitScope(url), 'api')
  for (const method of ['GET', 'PUT']) {
    assert.equal(authorizePanelRoute(method, '/api/panel/request-limits', 'admin').ok, true)
    for (const role of ['user', 'super'])
      assert.equal(authorizePanelRoute(method, '/api/panel/request-limits', role).ok, false)
  }
})
