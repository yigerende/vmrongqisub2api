/**
 * Intercept + rewrite official Claude telemetry bodies.
 * Call chain matches cc-bridge telemetry.rs + rewriter.rs:
 *   is_telemetry_path → fake 200 (auto on) / rewrite (if a body is forwarded)
 * Node never dials Anthropic; rewritten bodies are for the Go sidecar
 * and for stripping caller identity if a client hits these paths.
 */
import { buildFullEnvJson, buildProcessJson, DEFAULT_PROCESS_RANGES, officialDeviceID } from './telemetry-env.mjs'

export function isTelemetryPath(pathname = '') {
  const path = String(pathname || '')
  return (
    path.includes('/event_logging/batch') ||
    path.startsWith('/api/eval/') ||
    path.includes('/api/eval/') ||
    path.startsWith('/api/claude_code/metrics') ||
    path.includes('/api/claude_code/metrics') ||
    path.includes('/api/claude_code/organizations/metrics_enabled')
  )
}

export function fakeMetricsEnabledResponse() {
  return { metrics_logging_enabled: true }
}

export function fakeTelemetryResponse() {
  return {}
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function rewriteProcess(original, ranges = DEFAULT_PROCESS_RANGES) {
  let src = original
  if (typeof src === 'string') {
    try {
      const decoded = Buffer.from(src, 'base64').toString('utf8')
      src = JSON.parse(decoded)
    } catch {
      try {
        src = JSON.parse(src)
      } catch {
        src = {}
      }
    }
  }
  const next = buildProcessJson(ranges, Number(src?.uptime) || 0)
  if (typeof original === 'string') {
    return Buffer.from(JSON.stringify(next)).toString('base64')
  }
  return next
}

function rewriteUserAttributesJson(raw, identity) {
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object') return raw
    if (identity.device_id) obj.device_id = identity.device_id
    if (identity.user_id || identity.device_id) {
      obj.deviceID = identity.user_id || identity.device_id
      obj.id = identity.user_id || identity.device_id
    }
    if (identity.email) obj.email = identity.email
    if (identity.account_uuid) obj.accountUUID = identity.account_uuid
    if (identity.org_uuid) obj.organizationUUID = identity.org_uuid
    if (identity.subscription_type) obj.subscriptionType = identity.subscription_type
    delete obj.apiBaseUrlHost
    return JSON.stringify(obj)
  } catch {
    return raw
  }
}

function rewriteIdentityFields(obj, identity) {
  if (!obj) return
  const device = officialDeviceID(identity.user_id, identity.device_id)
  if (device && 'device_id' in obj) obj.device_id = device
  if ('email' in obj && identity.email) obj.email = identity.email
  if ('account_uuid' in obj && identity.account_uuid) obj.account_uuid = identity.account_uuid
  if ('organization_uuid' in obj) {
    if (identity.org_uuid) obj.organization_uuid = identity.org_uuid
    else delete obj.organization_uuid
  }
  delete obj.betas
  delete obj.model
  delete obj.additional_metadata
  delete obj.baseUrl
  delete obj.base_url
  delete obj.gateway
}

export function rewriteEventBatch(body, identity = {}) {
  const events = Array.isArray(body?.events) ? body.events : []
  const env = buildFullEnvJson(identity)
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    rewriteIdentityFields(event, identity)
    const data = asObject(event.event_data) || event
    rewriteIdentityFields(data, identity)
    if (data.env || event.env) {
      const target = data.env ? data : event
      target.env = env
    }
    if (data.process != null) data.process = rewriteProcess(data.process, identity.process)
    if (event.process != null && event !== data) event.process = rewriteProcess(event.process, identity.process)
    delete data.additional_metadata
    delete data.betas
    delete data.model
    if (typeof data.user_attributes === 'string') {
      data.user_attributes = rewriteUserAttributesJson(data.user_attributes, identity)
    }
    if (typeof event.user_attributes === 'string' && event !== data) {
      event.user_attributes = rewriteUserAttributesJson(event.user_attributes, identity)
    }
  }
  return body
}

export function rewriteGrowthbookEval(body, identity = {}) {
  const attrs = asObject(body?.attributes)
  if (!attrs) return body
  const device = identity.user_id || identity.device_id || ''
  attrs.id = device
  attrs.deviceID = device
  if ('email' in attrs && identity.email) attrs.email = identity.email
  if ('accountUUID' in attrs && identity.account_uuid) attrs.accountUUID = identity.account_uuid
  if (identity.org_uuid) attrs.organizationUUID = identity.org_uuid
  else delete attrs.organizationUUID
  if (identity.subscription_type) attrs.subscriptionType = identity.subscription_type
  delete attrs.apiBaseUrlHost
  if (identity.platform) attrs.platform = identity.platform
  if ('appVersion' in attrs && identity.cli_version) attrs.appVersion = identity.cli_version
  return body
}

export function rewriteGenericIdentity(body, identity = {}) {
  const obj = asObject(body)
  if (!obj) return body
  if ('device_id' in obj && identity.device_id) obj.device_id = identity.device_id
  if ('email' in obj && identity.email) obj.email = identity.email
  return body
}

export function rewriteTelemetryBody(body, pathname, identity = {}) {
  if (!body || typeof body !== 'object') return body
  const path = String(pathname || '')
  if (path.includes('/event_logging/batch')) return rewriteEventBatch(body, identity)
  if (path.includes('/api/eval/')) return rewriteGrowthbookEval(body, identity)
  return rewriteGenericIdentity(body, identity)
}

export function telemetryInterceptResponse(pathname) {
  const path = String(pathname || '')
  if (path.includes('metrics_enabled')) return fakeMetricsEnabledResponse()
  return fakeTelemetryResponse()
}
