/**
 * First-install onboarding: step booleans + per-user status.
 * Copy and URLs stay in the panel; this module only returns ids / done flags.
 */
import { normalizePanelRole } from './panel-acl.mjs'

export const ONBOARDING_STATE_KEY = 'onboarding_state'
export const MASTER_ONBOARDING_USER = '__master__'
/** docker-entrypoint writes this when VM2API_ADMIN_PASSWORD is empty. */
export const DEFAULT_ADMIN_PASSWORD = '123456'

export const STEPS_BY_ROLE = Object.freeze({
  admin: Object.freeze(['admin_password', 'egress', 'slot_account', 'schedulable', 'api_key', 'first_request']),
  user: Object.freeze(['egress', 'slot_account', 'schedulable', 'api_key', 'first_request']),
  super: Object.freeze(['schedulable', 'first_request']),
})

export function stepsForRole(role) {
  const r = normalizePanelRole(role)
  return STEPS_BY_ROLE[r] || STEPS_BY_ROLE.user
}

/** Master API key sets panelUser='master'; persist under a dedicated key. */
export function onboardingUserOf(req) {
  if (req?.apiKeyKind === 'master') return MASTER_ONBOARDING_USER
  const user = String(req?.panelUser || '').trim()
  return user || MASTER_ONBOARDING_USER
}

export function onboardingRoleOf(req) {
  if (req?.apiKeyKind === 'master') return 'admin'
  return normalizePanelRole(req?.panelRole)
}

export function panelBaseUrl(raw) {
  if (raw == null) return null
  const s = String(raw).trim().replace(/\/+$/, '')
  return s || null
}

export function isDefaultEnvAdminPassword(password) {
  return String(password ?? '') === DEFAULT_ADMIN_PASSWORD
}

/** Done unless env still holds the install default and that admin was never seeded. */
export function adminPasswordDone({ envPassword, envAdminExists } = {}) {
  return !(isDefaultEnvAdminPassword(envPassword) && !envAdminExists)
}

export function vmStepFacts(vms = []) {
  const list = Array.isArray(vms) ? vms : []
  return {
    vmWithTokenCount: list.filter((v) => v.has_token).length,
    schedulableCount: list.filter((v) => v.has_token && v.schedulable !== false).length,
  }
}

export function isStepDone(id, facts = {}) {
  switch (id) {
    case 'admin_password':
      return adminPasswordDone(facts)
    case 'egress':
      return Number(facts.proxyCount) >= 1
    case 'slot_account':
      return Number(facts.vmWithTokenCount) >= 1
    case 'schedulable':
      return Number(facts.schedulableCount) >= 1
    case 'api_key':
      return Number(facts.activeKeyCount) >= 1
    case 'first_request':
      return !!facts.hasFirstRequest
    default:
      return false
  }
}

export function needsWelcome(status, doneCount, total) {
  return status === 'pending' && (total === 0 || doneCount < total)
}

export function buildOnboardingPayload({
  user,
  role,
  status = 'pending',
  updated_at = null,
  base_url = null,
  facts = {},
} = {}) {
  const r = normalizePanelRole(role)
  const st = status === 'completed' || status === 'dismissed' ? status : 'pending'
  const steps = stepsForRole(r).map((id) => ({ id, done: isStepDone(id, facts) }))
  const done_count = steps.filter((s) => s.done).length
  const total = steps.length
  return {
    user,
    role: r,
    status: st,
    updated_at: updated_at || null,
    needs_welcome: needsWelcome(st, done_count, total),
    base_url: panelBaseUrl(base_url),
    steps,
    done_count,
    total,
  }
}

export function loadOnboardingState(settings) {
  const raw = settings?.get?.(ONBOARDING_STATE_KEY, {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw
}

export function saveOnboardingState(settings, map) {
  settings.set(ONBOARDING_STATE_KEY, map && typeof map === 'object' ? map : {})
  return map
}

export function recordOf(state, username) {
  const rec = state?.[username]
  if (!rec || typeof rec !== 'object') return { status: 'pending', updated_at: null }
  const status = rec.status
  if (status === 'completed' || status === 'dismissed' || status === 'pending') {
    return { status, updated_at: rec.updated_at || null }
  }
  return { status: 'pending', updated_at: rec.updated_at || null }
}

export function applyOnboardingAction(state, username, action, now = new Date().toISOString()) {
  const key = String(username || '')
  const next = { ...(state && typeof state === 'object' && !Array.isArray(state) ? state : {}) }
  switch (action) {
    case 'complete':
      next[key] = { status: 'completed', updated_at: now }
      return next
    case 'dismiss':
      next[key] = { status: 'dismissed', updated_at: now }
      return next
    case 'reset':
      delete next[key]
      return next
    default: {
      const err = new Error('action 必须是 complete、dismiss 或 reset')
      err.code = 'invalid_action'
      throw err
    }
  }
}
