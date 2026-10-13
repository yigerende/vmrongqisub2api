import { createRateLimiter } from '../core/security.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'

const KEY = 'gateway_request_limits'
const SCOPES = ['api', 'panel']
const DEFAULT = { enabled: false, rpm: 60, burst: 60 }

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validate(value) {
  if (!object(value) || Object.keys(value).some((key) => !['enabled', 'rpm', 'burst'].includes(key)))
    throw new Error('限流配置只支持 enabled、rpm、burst')
  if (typeof value.enabled !== 'boolean') throw new Error('enabled 必须为布尔值')
  if (typeof value.rpm !== 'number' || !Number.isFinite(value.rpm) || value.rpm < 0.001 || value.rpm > 1_000_000)
    throw new Error('持续请求速率必须在 0.001–1000000 次/分钟之间')
  if (!Number.isInteger(value.burst) || value.burst < 1 || value.burst > 1_000_000)
    throw new Error('突发容量必须是 1–1000000 之间的整数')
  return { enabled: value.enabled, rpm: value.rpm, burst: value.burst }
}

function environmentConfig(env, scope) {
  const prefix = scope === 'api' ? 'KIN_RATE_' : 'KIN_PANEL_RATE_'
  const config = { ...DEFAULT }
  let explicit = false
  for (const [name, field, scale] of [
    ['CAP', 'burst', 1],
    ['REFILL', 'rpm', 60],
  ]) {
    const raw = env[prefix + name]
    if (raw == null || raw === '') continue
    config[field] = Number(raw) * scale
    explicit = true
  }
  const enabled = env[prefix + 'ENABLED']
  if (enabled != null && enabled !== '') {
    if (!['0', '1', 'true', 'false'].includes(enabled)) throw new Error(`${prefix}ENABLED 必须为 0/1 或 true/false`)
    config.enabled = enabled === '1' || enabled === 'true'
    explicit = true
  }
  // Legacy capacity/refill variables are values only; limits now default off.
  return { ...validate(config), source: explicit ? 'environment' : 'default' }
}

export function requestLimitScope(url) {
  const pathname = new URL(url || '/', 'http://localhost').pathname
  return pathname === '/api/panel' || pathname.startsWith('/api/panel/') || pathname.startsWith('/admin/')
    ? 'panel'
    : 'api'
}

export function createRequestLimits({ settings = new SettingsRepo(), env = process.env, now = Date.now } = {}) {
  const fallback = Object.fromEntries(SCOPES.map((scope) => [scope, environmentConfig(env, scope)]))
  let overrides = settings.get(KEY, {})
  if (!object(overrides)) throw new Error('已保存的请求限流配置无效')
  const effective = (scope) => (overrides[scope] ? { ...validate(overrides[scope]), source: 'web' } : fallback[scope])
  const limiterOptions = (config) => ({
    capacity: config.burst,
    refillPerSec: config.rpm / 60,
    enabled: config.enabled,
  })
  const limiters = Object.fromEntries(
    SCOPES.map((scope) => [scope, createRateLimiter({ ...limiterOptions(effective(scope)), now })]),
  )
  const snapshot = () => Object.fromEntries(SCOPES.map((scope) => [scope, { ...effective(scope) }]))
  return {
    snapshot,
    allow(scope, identity) {
      return limiters[scope](identity)
    },
    save(patch) {
      if (!object(patch) || !Object.keys(patch).length || Object.keys(patch).some((key) => !SCOPES.includes(key)))
        throw new Error('请选择 api 或 panel 限流配置')
      const next = { ...overrides }
      for (const scope of SCOPES) {
        if (!Object.hasOwn(patch, scope)) continue
        if (patch[scope] === null) delete next[scope]
        else next[scope] = validate(patch[scope])
      }
      // Persist before changing the live limiter; failed saves have no effect.
      settings.set(KEY, next)
      overrides = next
      for (const scope of SCOPES) limiters[scope].configure(limiterOptions(effective(scope)))
      return snapshot()
    },
  }
}

/** Invoked after panel authentication and admin RBAC. */
export async function handleRequestLimits({ req, res, url, limits, readBody, json }) {
  if (url.pathname !== '/api/panel/request-limits') return false
  if (!['GET', 'PUT'].includes(req.method)) return json(res, 405, { ok: false, error: { message: '方法不支持' } })
  try {
    const data = req.method === 'GET' ? limits.snapshot() : limits.save(await readBody(req, 8192))
    json(res, 200, { ok: true, data })
  } catch (error) {
    json(res, 400, { ok: false, error: { message: error.message } })
  }
  return true
}
