import { redactSecrets } from '../core/security.mjs'

function summarizeBody(body) {
  if (!body || typeof body !== 'object') return { empty: true }
  const messages = Array.isArray(body.messages) ? body.messages : null
  const roles = messages ? messages.map((m) => m?.role).filter(Boolean) : []
  let systemLen = 0
  if (typeof body.system === 'string') systemLen = body.system.length
  else if (Array.isArray(body.system)) {
    systemLen = body.system.reduce((n, b) => n + (typeof b === 'string' ? b.length : (b?.text || '').length), 0)
  }
  return {
    model: body.model || null,
    stream: !!body.stream,
    max_tokens: body.max_tokens ?? body.max_output_tokens ?? null,
    messages_count: messages ? messages.length : body.input != null ? 1 : 0,
    roles,
    tools_count: Array.isArray(body.tools) ? body.tools.length : 0,
    has_thinking: body.thinking != null,
    system_len: systemLen,
    top_level_keys: Object.keys(body).sort(),
  }
}

function redactHeaders(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    const key = String(k).toLowerCase()
    if (key === 'authorization' || key === 'x-api-key' || key === 'cookie' || key === 'set-cookie') {
      out[key] = '***REDACTED***'
    } else if (key === 'x-panel-token') {
      out[key] = '***REDACTED***'
    } else {
      out[key] = typeof v === 'string' ? v.slice(0, 512) : v
    }
  }
  return out
}

const SENSITIVE_KEY = /authorization|token|password|secret|cookie|api[_-]?key/i
const SNAP_MAX_STRING = 80
const SNAP_MAX_ARRAY = 24
const SNAP_MAX_DEPTH = 6
const SNAP_MAX_TOTAL = 12000
const IMAGE_DATA_KEYS = new Set(['data', 'base64', 'b64_json'])

function imagePayloadSummary(value) {
  if (typeof value === 'string') return `…[${value.length} bytes]`
  return '[omitted-image]'
}

function redactImagePayloads(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactImagePayloads(item, seen))
  const type = value.type
  const isImage = type === 'image' || type === 'input_image' || type === 'image_url' || value.source || value.image_url
  const out = {}
  for (const [key, nested] of Object.entries(value)) {
    if (IMAGE_DATA_KEYS.has(key) && typeof nested === 'string' && nested.length > 32) {
      out[key] = imagePayloadSummary(nested)
      continue
    }
    if (isImage && key === 'source' && nested && typeof nested === 'object') {
      out[key] = {
        type: nested.type || 'base64',
        media_type: nested.media_type || null,
        url: Boolean(nested.url),
        bytes: typeof nested.data === 'string' ? nested.data.length : 0,
      }
      continue
    }
    if (isImage && key === 'image_url' && nested && typeof nested === 'object') {
      out[key] = { url: Boolean(nested.url), detail: nested.detail || null }
      continue
    }
    out[key] = redactImagePayloads(nested, seen)
  }
  return out
}

export function sanitizeRequestBodySnapshot(value, opts = {}, seen = new WeakSet(), depth = 0) {
  const maxString = opts.maxStringChars ?? SNAP_MAX_STRING
  const maxArray = opts.maxArrayItems ?? SNAP_MAX_ARRAY
  const maxDepth = opts.maxDepth ?? SNAP_MAX_DEPTH
  if (value == null) return value
  if (typeof value === 'string') {
    return value.length > maxString ? value.slice(0, maxString) + `…[${value.length}]` : value
  }
  if (typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  if (depth >= maxDepth) return '[MaxDepth]'
  seen.add(value)
  if (Array.isArray(value)) {
    const items = value.slice(0, maxArray).map((v) => sanitizeRequestBodySnapshot(v, opts, seen, depth + 1))
    if (value.length > maxArray) items.push(`…[${value.length - maxArray} more]`)
    return items
  }
  const out = {}
  const isImage =
    value.type === 'image' ||
    value.type === 'input_image' ||
    value.type === 'image_url' ||
    value.source ||
    value.image_url
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = '[REDACTED]'
      continue
    }
    if (k === 'encrypted_content') {
      out[k] = `…[${String(v || '').length} chars]`
      continue
    }
    if (k === 'tools' && Array.isArray(v)) {
      out[k] = v
        .slice(0, maxArray)
        .map((t) => ({ type: t?.type || 'function', name: t?.name || t?.function?.name || null }))
      continue
    }
    if (IMAGE_DATA_KEYS.has(k) && typeof v === 'string' && v.length > 32) {
      out[k] = imagePayloadSummary(v)
      continue
    }
    if (isImage && k === 'source' && v && typeof v === 'object') {
      out[k] = {
        type: v.type || 'base64',
        media_type: v.media_type || null,
        url: Boolean(v.url),
        bytes: typeof v.data === 'string' ? v.data.length : 0,
      }
      continue
    }
    out[k] = sanitizeRequestBodySnapshot(v, opts, seen, depth + 1)
  }
  let raw = ''
  try {
    raw = JSON.stringify(out)
  } catch {
    return out
  }
  if (raw.length > (opts.maxTotalChars ?? SNAP_MAX_TOTAL)) {
    return { _truncated: true, _chars: raw.length, preview: raw.slice(0, opts.maxTotalChars ?? SNAP_MAX_TOTAL) }
  }
  return out
}

function clampBody(obj, maxChars = 200_000) {
  let raw
  try {
    raw = redactSecrets(redactImagePayloads(obj))
  } catch {
    raw = '{"error":"redact_failed"}'
  }
  if (raw.length <= maxChars) {
    try {
      return JSON.parse(raw)
    } catch {
      return { _raw: raw.slice(0, maxChars) }
    }
  }
  return { _truncated: true, _chars: raw.length, preview: raw.slice(0, maxChars) }
}

/**
 * Client-facing response as stored in a debug record. The body stays raw text
 * (SSE frames or JSON) so the panel can show exactly what went out; only
 * credential-shaped substrings are masked.
 */
function debugResponse(captured) {
  let body = captured.body || ''
  let truncated = !!captured.truncated
  if (captured.chunks) {
    const decoder = new TextDecoder()
    let remaining = captured.length
    const parts = []
    for (const chunk of captured.chunks) {
      const n = Math.min(chunk.length, remaining)
      parts.push(decoder.decode(chunk.subarray(0, n), { stream: true }))
      remaining -= n
    }
    parts.push(decoder.decode())
    body = parts.join('')
    truncated ||= body.length > captured.limit
    body = body.slice(0, captured.limit)
  }
  try {
    body = JSON.parse(redactSecrets(body))
  } catch {}
  return {
    status: captured.status ?? null,
    headers: captured.headers || null,
    body,
    bytes: captured.bytes || 0,
    truncated,
  }
}

export function buildDebugRecord(summary, { ctx, extra, maxDebugBodyChars }) {
  return {
    ...summary,
    headers: ctx.headers,
    inbound_summary: extra.inbound_summary || summarizeBody(extra.inbound_body),
    request_body_snapshot:
      !extra.classifier && extra.inbound_body != null ? sanitizeRequestBodySnapshot(extra.inbound_body) : null,
    inbound_body:
      !extra.classifier && extra.inbound_body != null ? clampBody(extra.inbound_body, maxDebugBodyChars) : null,
    hop_meta: extra.hop_meta || null,
    via: extra.via || extra.hop_meta?.via || null,
    upstream_status: extra.upstream_status ?? null,
    outbound_summary: extra.outbound_summary || null,
    cache_prefix: extra.cache_prefix || null,
    cache_continuity: extra.cache_continuity || null,
    classifier: extra.classifier || null,
    outbound_headers:
      ctx.capture_outbound && extra.outbound_headers != null ? redactHeaders(extra.outbound_headers) : null,
    outbound_body:
      ctx.capture_outbound && !extra.classifier && extra.outbound_body != null
        ? clampBody(extra.outbound_body, maxDebugBodyChars)
        : null,
    response: ctx.response ? debugResponse(ctx.response) : null,
  }
}

export { summarizeBody, redactHeaders, clampBody }
