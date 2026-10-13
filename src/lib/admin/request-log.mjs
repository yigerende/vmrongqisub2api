/**
 * Request logging — sub2api UsageLog + access-log inspired (SQLite-backed).
 *
 * Modes:
 *   off    — no writes
 *   normal — summary row (tokens, status, duration, key/vm ids; no bodies)
 *   debug  — normal + full redacted request record (headers/body/hop_meta)
 *
 * Storage: `request_logs` (summaries) + `request_log_debug` (full records).
 * Optional JSONL mirror for external log shippers: KIN_REQUEST_LOG_JSONL=1
 * (writes the previous data/request-logs/YYYY-MM-DD.jsonl format alongside).
 *
 * Env: KIN_REQUEST_LOG_MODE=off|normal|debug (default normal)
 * Per-request override: X-Kin-Debug: 1 or X-Kin-Log: debug|normal|off
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildDebugRecord, summarizeBody, redactHeaders, clampBody } from './debug-record.mjs'
export { sanitizeRequestBodySnapshot } from './debug-record.mjs'
import { resolveStoreDb } from '../db/database.mjs'
import { UsageLogsRepo } from '../db/repos/usage-logs-repo.mjs'
import { ReportReader } from '../db/report-reader.mjs'
import { LogWriter } from '../db/log-writer.mjs'
import { LogDetails } from '../db/log-details.mjs'
import { persistLogBatch } from '../db/persist-log-batch.mjs'
import { classifyRequestError, resolveMutedErrorClasses } from './error-class.mjs'
import { costColumnsFromUsage, normalizeUsage } from './pricing.mjs'
import { normalizeCacheTtl } from '../protocol/cache-ttl.mjs'
import { REASONING_EFFORTS, sessionIdForLog } from '../protocol/log-fields.mjs'

/** Persist the token a client actually sent — only for failed ingress auth. */
export function presentedApiKeyForLog(token) {
  const t = String(token || '').trim()
  if (!t || t.startsWith('kin-panel-')) return ''
  return t.slice(0, 240)
}

const MODES = new Set(['off', 'normal', 'debug'])

const DEFAULT_RETAIN_DAYS = 7
const DEFAULT_DEBUG_RETAIN_DAYS = 3
const DEFAULT_MAX_MB = 2048
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000

function clampInt(value, min, max, fallback) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** Keep summary retain_days, a shorter debug window, and a hard size cap. */
export function normalizeLoggingConfig(raw = {}) {
  const modeRaw = String(raw.mode || 'normal')
    .trim()
    .toLowerCase()
  const mode = MODES.has(modeRaw) ? modeRaw : 'normal'
  const retainDays = clampInt(raw.retain_days ?? raw.retainDays, 1, 90, DEFAULT_RETAIN_DAYS)
  let debugRetainDays = clampInt(
    raw.debug_retain_days ?? raw.debugRetainDays,
    1,
    90,
    Math.min(DEFAULT_DEBUG_RETAIN_DAYS, retainDays),
  )
  if (debugRetainDays > retainDays) debugRetainDays = retainDays
  return {
    ...raw,
    mode,
    retain_days: retainDays,
    debug_retain_days: debugRetainDays,
    max_mb: clampInt(raw.max_mb ?? raw.maxMb, 0, 102400, DEFAULT_MAX_MB),
  }
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

function safeIp(req) {
  const xf = String(req.headers?.['x-forwarded-for'] || '')
    .split(',')[0]
    .trim()
  const raw = xf || req.socket?.remoteAddress || ''
  return String(raw).slice(0, 45)
}

/**
 * Cache-creation TTL breakdown, normalized like Sub2API:
 * prefer usage.cache_creation.ephemeral_5m/1h; when the breakdown is absent
 * but cache_creation_input_tokens > 0, attribute everything to the resolved TTL
 * (default 1h).
 */
function cacheCreationBreakdown(usage) {
  if (!usage || typeof usage !== 'object') {
    return { cache_creation_5m_tokens: null, cache_creation_1h_tokens: null }
  }
  const nested = usage.cache_creation
  let five = Number(nested?.ephemeral_5m_input_tokens) || 0
  let hour = Number(nested?.ephemeral_1h_input_tokens) || 0
  const total = Number(usage.cache_creation_input_tokens ?? usage.cache_creation_tokens) || 0
  if (five === 0 && hour === 0 && total > 0) {
    if (normalizeCacheTtl(usage.cache_ttl) === '1h') hour = total
    else five = total
  }
  if (five === 0 && hour === 0) {
    return { cache_creation_5m_tokens: null, cache_creation_1h_tokens: null }
  }
  return { cache_creation_5m_tokens: five, cache_creation_1h_tokens: hour }
}

/** Tri-state model mismatch: null = upstream did not declare a model. */
function modelMismatch(requested, upstream) {
  if (!requested || !upstream) return null
  const norm = (m) =>
    String(m)
      .split('/')
      .filter(Boolean)
      .pop()
      .replace(/\[1m\]$/i, '')
      .toLowerCase()
  return norm(requested) === norm(upstream) ? 0 : 1
}

export function resolveLogMode(envMode, req) {
  const hdr = String(req?.headers?.['x-kin-log'] || '')
    .trim()
    .toLowerCase()
  if (MODES.has(hdr)) return hdr
  if (String(req?.headers?.['x-kin-debug'] || '') === '1') return 'debug'
  const base = String(envMode || 'normal')
    .trim()
    .toLowerCase()
  return MODES.has(base) ? base : 'normal'
}

export function newRequestId(req) {
  const incoming = String(req?.headers?.['x-request-id'] || '').trim()
  if (incoming && incoming.length <= 128) return incoming
  return crypto.randomUUID()
}

export class RequestLogStore {
  enableWriter(dbPath) {
    this.writerPath = dbPath
    this._autoCheckpoint = Number(this.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint)
    this.db.exec('PRAGMA wal_autocheckpoint = 0')
    this.writer = new LogWriter(dbPath, (rows) => persistLogBatch(this.db, this.repo, rows))
    this.details = new LogDetails(dbPath, { root: this.root })
  }

  async closeWriter() {
    const writer = this.writer
    const details = this.details
    try {
      const results = await Promise.allSettled([writer?.close(), details?.close()])
      for (const result of results) if (result.status === 'rejected') throw result.reason
    } finally {
      this.writer = null
      this.details = null
      if (Number.isFinite(this._autoCheckpoint)) this.db.exec(`PRAGMA wal_autocheckpoint = ${this._autoCheckpoint}`)
    }
  }

  enableReader(dbPath) {
    this.readerPath = dbPath
  }

  async read(method, ...args) {
    if (this.readerPaused) throw Object.assign(new Error('reporting is paused for restore'), { status: 503 })
    await this.writer?.flush()
    if (method === 'getDebug' || method === 'listDebug') await this.details?.flush()
    if (this.readerPaused) throw Object.assign(new Error('reporting is paused for restore'), { status: 503 })
    if (!this.readerPath) return this[method](...args)
    this.reader ||= new ReportReader(this.readerPath)
    return this.reader.call('log', method, args, { mutedErrorClasses: this.mutedErrorClasses })
  }

  async readView(kind, method, ...args) {
    if (this.readerPaused) throw Object.assign(new Error('reporting is paused for restore'), { status: 503 })
    await this.writer?.flush()
    if (this.readerPaused) throw Object.assign(new Error('reporting is paused for restore'), { status: 503 })
    if (!this.readerPath) throw new Error('report reader is not configured')
    this.reader ||= new ReportReader(this.readerPath)
    return this.reader.call(kind, method, args, { mutedErrorClasses: this.mutedErrorClasses })
  }

  async closeReader() {
    const reader = this.reader
    this.reader = null
    await reader?.close()
  }

  count() {
    return this.repo.count()
  }

  async snapshotAsync() {
    const snapshot = this.snapshot({ count: false })
    snapshot.total_rows = await this.read('count')
    return snapshot
  }

  constructor({
    dataDir,
    db,
    mode = process.env.KIN_REQUEST_LOG_MODE || 'normal',
    maxDebugBodyChars = Number(process.env.KIN_REQUEST_LOG_DEBUG_CHARS || 200000),
    retainDays = Number(process.env.KIN_REQUEST_LOG_RETAIN_DAYS || DEFAULT_RETAIN_DAYS),
    debugRetainDays = Number(process.env.KIN_REQUEST_LOG_DEBUG_RETAIN_DAYS || DEFAULT_DEBUG_RETAIN_DAYS),
    maxMb = Number(process.env.KIN_REQUEST_LOG_MAX_MB || DEFAULT_MAX_MB),
    jsonlMirror = process.env.KIN_REQUEST_LOG_JSONL === '1',
  } = {}) {
    this.dataDir = dataDir || path.join(process.cwd(), 'data')
    this.db = resolveStoreDb({ db, dataDir: this.dataDir })
    this.repo = new UsageLogsRepo(this.db)
    this.root = path.join(this.dataDir, 'request-logs')
    this.mode = MODES.has(String(mode).toLowerCase()) ? String(mode).toLowerCase() : 'normal'
    this.maxDebugBodyChars = Number.isFinite(maxDebugBodyChars) ? maxDebugBodyChars : 200000
    this.retainDays = Number.isFinite(retainDays) && retainDays > 0 ? retainDays : DEFAULT_RETAIN_DAYS
    this.debugRetainDays =
      Number.isFinite(debugRetainDays) && debugRetainDays > 0 ? debugRetainDays : DEFAULT_DEBUG_RETAIN_DAYS
    if (this.debugRetainDays > this.retainDays) this.debugRetainDays = this.retainDays
    this.maxMb = Number.isFinite(maxMb) && maxMb >= 0 ? maxMb : DEFAULT_MAX_MB
    this.jsonlMirror = !!jsonlMirror
    this.mutedErrorClasses = resolveMutedErrorClasses(null)
    this._mem = [] // recent normal summaries for panel hot path
    this._memMax = 200
    this._cleanupTimer = null
  }

  setConfig({ mode, retainDays, debugRetainDays, maxMb, mutedErrorClasses } = {}) {
    if (mode != null) {
      const m = String(mode).trim().toLowerCase()
      if (MODES.has(m)) this.mode = m
    }
    if (retainDays != null) {
      const n = Number(retainDays)
      if (Number.isFinite(n) && n > 0) this.retainDays = n
    }
    if (debugRetainDays != null) {
      const n = Number(debugRetainDays)
      if (Number.isFinite(n) && n > 0) this.debugRetainDays = n
    }
    if (maxMb != null) {
      const n = Number(maxMb)
      if (Number.isFinite(n) && n >= 0) this.maxMb = n
    }
    if (this.debugRetainDays > this.retainDays) this.debugRetainDays = this.retainDays
    if (mutedErrorClasses !== undefined) {
      this.mutedErrorClasses = resolveMutedErrorClasses(mutedErrorClasses)
    }
    return this.snapshot()
  }

  /** Kept for API compat + post-restore hook (state lives in DB). */
  reload() {
    this._mem = []
  }

  /** Re-bind to a fresh DB connection (after backup restore). */
  rebind(db) {
    this.db = db
    this.repo = new UsageLogsRepo(db)
    this._mem = []
    if (this.writerPath) this.enableWriter(this.writerPath)
  }

  start(req, { protocol = null, pathName = null } = {}) {
    const requestId = newRequestId(req)
    try {
      req.headers = req.headers || {}
    } catch {}
    const mode = resolveLogMode(this.mode, req)
    return {
      request_id: requestId,
      mode,
      t0: Date.now(),
      protocol,
      path: pathName || req.url || '',
      method: req.method || 'POST',
      ip: safeIp(req),
      user_agent: String(req.headers?.['user-agent'] || '').slice(0, 512),
      headers: mode === 'debug' ? redactHeaders(req.headers) : null,
      // Outbound bodies carry the gateway's rewrite (persona / overlay) and are
      // readable by the owning tenant; only the operator's configured mode may
      // enable them, never the caller's x-kin-debug / x-kin-log header.
      capture_outbound: this.mode === 'debug',
    }
  }

  /**
   * Debug mode only: mirror what the client actually received (status,
   * headers, body bytes up to maxDebugBodyChars) onto `ctx.response` so
   * finish() can store it next to the inbound/outbound bodies. Normal mode
   * never wraps the response.
   */
  tapResponse(ctx, res) {
    if (!ctx || ctx.mode !== 'debug' || !res || ctx.response) return
    const limit = Math.max(0, this.maxDebugBodyChars)
    const captured = { status: null, headers: null, chunks: [], length: 0, limit, bytes: 0, truncated: false }
    ctx.response = captured
    // Keep bounded raw bytes. UTF-8 decoding/redaction/JSON run in the detail
    // worker, not for every streamed frame on the scheduling event loop.
    const byteLimit = limit * 4
    const take = (chunk, encoding) => {
      if (chunk == null || typeof chunk === 'function') return
      const buf =
        typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk
      if (!(buf instanceof Uint8Array)) return
      captured.bytes += buf.byteLength
      let offset = 0
      while (offset < buf.byteLength && captured.length < byteLimit) {
        const within = captured.length % 16384
        if (!within) captured.chunks.push(Buffer.alloc(Math.min(16384, byteLimit - captured.length)))
        const target = captured.chunks.at(-1)
        const n = Math.min(buf.byteLength - offset, target.length - within)
        target.set(buf.subarray(offset, offset + n), within)
        captured.length += n
        offset += n
      }
      if (offset < buf.byteLength) captured.truncated = true
    }
    const write = res.write
    const end = res.end
    res.write = function tappedWrite(chunk, encoding, cb) {
      take(chunk, encoding)
      return write.call(this, chunk, encoding, cb)
    }
    res.end = function tappedEnd(chunk, encoding, cb) {
      take(chunk, encoding)
      return end.call(this, chunk, encoding, cb)
    }
    res.once('finish', () => {
      captured.status = res.statusCode || null
      try {
        captured.headers = redactHeaders(res.getHeaders?.() || {})
      } catch {}
    })
  }

  /**
   * Write normal summary always (unless off).
   * Write debug full record when mode===debug.
   */
  finish(ctx, extra = {}) {
    if (!ctx || ctx.mode === 'off') return null
    const duration_ms = Math.max(0, Date.now() - (ctx.t0 || Date.now()))
    const usage = normalizeUsage(extra.usage || {})
    const summary = {
      id: 'log_' + crypto.randomBytes(6).toString('hex'),
      request_id: ctx.request_id,
      ts: new Date().toISOString(),
      log_mode: ctx.mode,
      method: ctx.method,
      path: extra.path || ctx.path,
      protocol: extra.protocol || ctx.protocol || null,
      model: extra.model || null,
      stream: !!extra.stream,
      status: extra.status ?? null,
      duration_ms,
      api_key_kind: extra.api_key_kind || null,
      api_key_id: extra.api_key_id || null,
      vm_id: extra.vm_id || null,
      account_id: extra.account_id || null,
      workspace: extra.workspace || null,
      input_tokens: extra.input_tokens ?? usage.input_tokens ?? null,
      output_tokens: extra.output_tokens ?? usage.output_tokens ?? null,
      error_code: extra.error_code || null,
      error_message: extra.error_message ? String(extra.error_message).slice(0, 300) : null,
      user_agent: ctx.user_agent,
      ip: ctx.ip,
      api_key_presented: extra.api_key_presented ? presentedApiKeyForLog(extra.api_key_presented) : null,
      has_tools: extra.has_tools ?? null,
      via: extra.via || extra.hop_meta?.via || null,
      cache_read_tokens: extra.cache_read_tokens ?? usage.cache_read_tokens ?? usage.cache_read_input_tokens ?? null,
      cache_creation_tokens:
        extra.cache_creation_tokens ?? usage.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? null,
      ...cacheCreationBreakdown(usage),
      requested_model: extra.requested_model || extra.model || null,
      upstream_model: extra.upstream_model || null,
      model_mismatch: modelMismatch(extra.requested_model || extra.model, extra.upstream_model),
      first_token_ms: extra.first_token_ms ?? null,
      stop_reason: extra.stop_reason || usage.stop_reason || null,
      attempt_count: extra.attempt_count ?? null,
      final_state: extra.final_state || null,
      final_account_id: extra.final_account_id || extra.account_id || null,
      session_id: sessionIdForLog(extra.session_id),
      outbound_session_id: sessionIdForLog(extra.outbound_session_id),
      reasoning_effort: REASONING_EFFORTS.has(extra.reasoning_effort) ? extra.reasoning_effort : null,
      // Gate verdict JSON from intercept-gate; the risk audit groups on it.
      intercept: extra.intercept ? String(extra.intercept).slice(0, 400) : null,
      // sub2api ownership + billing columns
      user_id: extra.user_id ?? null,
      vm_owner_user_id: this.repo.vmOwnerOf(extra.vm_id),
      group_id: extra.group_id ?? 1,
      rate_multiplier: Number.isFinite(Number(extra.rate_multiplier)) ? Number(extra.rate_multiplier) : 1,
      ...costColumnsFromUsage(
        {
          ...usage,
          input_tokens: extra.input_tokens ?? usage.input_tokens,
          output_tokens: extra.output_tokens ?? usage.output_tokens,
          cache_read_tokens: extra.cache_read_tokens ?? usage.cache_read_input_tokens ?? usage.cache_read_tokens,
          cache_creation_tokens:
            extra.cache_creation_tokens ?? usage.cache_creation_input_tokens ?? usage.cache_creation_tokens,
          cache_creation_5m_tokens: extra.cache_creation_5m_tokens ?? usage.cache_creation_5m_tokens,
          cache_creation: usage.cache_creation,
        },
        extra.upstream_model || extra.model || extra.requested_model,
      ),
    }
    // sub2api actual_cost: official cost × group rate multiplier (0 is a valid rate)
    if (summary.total_cost != null) {
      summary.actual_cost = summary.total_cost * summary.rate_multiplier
    }
    const classified = classifyRequestError(summary)
    if (classified?.error_class) summary.error_class = classified.error_class

    try {
      if (!this.writer) this.repo.insertSummaryIfAbsent(summary)
    } catch {}
    this._mem.push(summary)
    if (this._mem.length > this._memMax) this._mem = this._mem.slice(-this._memMax)

    const debug =
      ctx.mode === 'debug'
        ? {
            ctx: { headers: ctx.headers, capture_outbound: ctx.capture_outbound, response: ctx.response },
            extra: {
              inbound_body: extra.classifier ? null : extra.inbound_body,
              inbound_summary: extra.inbound_summary,
              hop_meta: extra.hop_meta,
              via: extra.via,
              upstream_status: extra.upstream_status,
              outbound_summary: extra.outbound_summary,
              cache_prefix: extra.cache_prefix,
              cache_continuity: extra.cache_continuity,
              classifier: extra.classifier,
              outbound_headers: ctx.capture_outbound ? extra.outbound_headers : null,
              outbound_body: ctx.capture_outbound && !extra.classifier ? extra.outbound_body : null,
            },
            maxDebugBodyChars: this.maxDebugBodyChars,
          }
        : null
    if (this.details) {
      if (debug || this.jsonlMirror) this.details.enqueue({ summary, debug, jsonl: this.jsonlMirror })
    } else if (!this.writerPath) {
      // Standalone/offline store compatibility. A stopped production worker must
      // never redirect large payloads or file writes onto the gateway thread.
      if (debug) {
        try {
          this.repo.insertDebug(summary.request_id || summary.id, summary.ts, buildDebugRecord(summary, debug))
        } catch {}
      }
      if (this.jsonlMirror) this._appendJsonl(summary)
    }
    try {
      this.writer?.enqueue({ summary })
    } catch (error) {
      console.warn('[request-log] unable to persist request summary:', error?.code || error?.message)
    }
    return summary
  }

  /** Optional legacy JSONL mirror for external log collectors. */
  _appendJsonl(summary) {
    try {
      fs.mkdirSync(this.root, { recursive: true })
      const file = path.join(this.root, `${dayKey()}.jsonl`)
      fs.appendFileSync(file, JSON.stringify(summary) + '\n', { mode: 0o600 })
    } catch {}
  }

  _mutedExclude(opts = {}) {
    if (opts.error_class || opts.include_muted) return null
    if (opts.exclude_error_class != null && String(opts.exclude_error_class).trim() !== '') {
      return opts.exclude_error_class
    }
    return this.mutedErrorClasses.length ? this.mutedErrorClasses.join(',') : null
  }

  _dropMuted(items, exclude) {
    if (!exclude) return items
    const blocked = new Set(
      String(exclude)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    if (!blocked.size) return items
    return (items || []).filter((row) => !row.error_class || !blocked.has(row.error_class))
  }

  listNormal({ limit = 50, ...filters } = {}) {
    return this.queryNormal({ limit, ...filters }).items
  }

  /** Filtered + paginated query with total (panel). Default hides muted classes. */
  queryNormal(opts = {}) {
    const exclude = this._mutedExclude(opts)
    const result = this.repo.query({ ...opts, exclude_error_class: exclude })
    result.items = this._dropMuted(result.items, exclude)
    return result
  }

  exportRows(opts = {}) {
    const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 2000))
    return this.queryNormal({ ...opts, limit, offset: 0, maxLimit: 5000 })
  }

  /** Aggregated stats for charts. */
  aggregate(opts = {}) {
    return this.repo.aggregate(opts)
  }

  totals() {
    return this.repo.totals()
  }

  hasSuccessfulRequest(opts = {}) {
    return this.repo.hasSuccessfulRequest(opts)
  }

  billingStats(opts = {}) {
    return this.repo.billingStats(opts)
  }

  ownerBilling(opts = {}) {
    return this.repo.ownerBilling(opts)
  }

  costByModel(opts = {}) {
    return this.repo.costByModel(opts)
  }

  vmUsageStats(opts = {}) {
    return this.repo.vmUsageStats(opts)
  }

  keyUsageStats(opts = {}) {
    return this.repo.keyUsageStats(opts)
  }

  /** Windowed SLA / QPS / TTFT snapshot for overview + log analysis. */
  windowStats(opts = {}) {
    return this.repo.windowStats(opts)
  }

  protocolEntryStats(opts = {}) {
    return this.repo.protocolEntryStats(opts)
  }

  listDebug({
    limit = 20,
    exclude_error_class = null,
    include_muted = false,
    error_class = null,
    owner_user_id = null,
  } = {}) {
    const exclude = this._mutedExclude({ exclude_error_class, include_muted, error_class })
    const n = Math.max(1, Math.min(100, Number(limit) || 20))
    const pool = this.repo.listDebug({ limit: exclude ? Math.min(200, n * 15) : n, owner_user_id })
    const items = error_class ? pool.filter((row) => row.error_class === error_class) : this._dropMuted(pool, exclude)
    return items.slice(0, n)
  }

  getDebug(requestId, { owner_user_id = null } = {}) {
    if (!requestId) return null
    const rec = this.repo.getDebug(requestId) || this.repo.getByRequestId(requestId)
    if (!rec) return null
    if (owner_user_id && !this.repo.belongsToOwner(requestId, owner_user_id)) return null
    return rec
  }

  snapshot({ count = true } = {}) {
    return {
      mode: this.mode,
      retain_days: this.retainDays,
      debug_retain_days: this.debugRetainDays,
      max_mb: this.maxMb,
      muted_error_classes: this.mutedErrorClasses.slice(),
      recent_normal: this._mem.length,
      backend: 'sqlite',
      jsonl_mirror: this.jsonlMirror,
      detail_writer: this.details?.snapshot() || null,
      total_rows: (() => {
        if (!count) return null
        try {
          return this.repo.count()
        } catch {
          return null
        }
      })(),
    }
  }

  /** Retention: delete rows older than retain windows, then enforce max_mb. */
  cleanup() {
    const options = {
      retainDays: this.retainDays,
      debugRetainDays: this.debugRetainDays,
      maxBytes: this.maxMb > 0 ? this.maxMb * 1024 * 1024 : 0,
    }
    if (this.details)
      return this.details.cleanup(options).catch((error) => {
        console.warn('[request-log] background cleanup failed:', error?.code || error?.message)
        return null
      })
    if (this.writerPath) return null
    try {
      this.repo.cleanup(options)
    } catch {}
    this._cleanupLegacyFiles(this.retainDays, this.root)
    this._cleanupLegacyFiles(this.debugRetainDays, path.join(this.root, 'debug'))
  }

  startCleanupScheduler({ intervalMs = CLEANUP_INTERVAL_MS } = {}) {
    this.stopCleanupScheduler()
    const ms = Math.max(60_000, Number(intervalMs) || CLEANUP_INTERVAL_MS)
    const run = () => {
      try {
        this.cleanup()
      } catch {}
    }
    this._cleanupTimer = setInterval(run, ms)
    if (typeof this._cleanupTimer.unref === 'function') this._cleanupTimer.unref()
  }

  stopCleanupScheduler() {
    clearInterval(this._cleanupTimer)
    this._cleanupTimer = null
  }

  _cleanupLegacyFiles(days, dir) {
    const cutoff = Date.now() - days * 86400_000
    try {
      if (!fs.existsSync(dir)) return
      for (const name of fs.readdirSync(dir)) {
        if (!/^\d{4}-\d{2}-\d{2}/.test(name)) continue
        const dayMs = Date.parse(name.slice(0, 10) + 'T00:00:00Z')
        if (!Number.isFinite(dayMs) || dayMs >= cutoff) continue
        fs.rmSync(path.join(dir, name), { recursive: true, force: true })
      }
    } catch {}
  }
}

const EXPORT_COLUMNS = [
  'ts',
  'request_id',
  'method',
  'path',
  'protocol',
  'status',
  'error_class',
  'error_code',
  'error_message',
  'error_label',
  'model',
  'vm_id',
  'ip',
  'api_key_presented',
  'duration_ms',
  'first_token_ms',
  'input_tokens',
  'output_tokens',
  'total_cost',
  'api_key_id',
  'api_key_kind',
]

function csvCell(v) {
  if (v == null || v === '') return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function logsToCsv(items = []) {
  const header = EXPORT_COLUMNS.join(',')
  const rows = items.map((row) => EXPORT_COLUMNS.map((k) => csvCell(row[k])).join(','))
  return [header, ...rows].join('\n') + (items.length ? '\n' : '')
}

export function logsToJsonl(items = []) {
  return (
    items
      .map((row) => {
        const out = {}
        for (const k of EXPORT_COLUMNS) out[k] = row[k] ?? null
        return JSON.stringify(out)
      })
      .join('\n') + (items.length ? '\n' : '')
  )
}

export { summarizeBody, redactHeaders, clampBody, DEFAULT_RETAIN_DAYS, DEFAULT_DEBUG_RETAIN_DAYS, DEFAULT_MAX_MB }
