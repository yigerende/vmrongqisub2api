import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { Worker } from 'node:worker_threads'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { performance } from 'node:perf_hooks'
import { openDatabase, closeDatabase } from '../../src/lib/db/database.mjs'
import { RequestLogStore } from '../../src/lib/admin/request-log.mjs'
import { StickyRouter } from '../../src/lib/pool/sticky-router.mjs'
import { AccountQuota } from '../../src/lib/pool/account-quota.mjs'
import { SessionLimitRegistry } from '../../src/lib/pool/session-limit.mjs'
import { handleCodexProtocol } from '../../src/lib/protocol/handle-codex.mjs'
import { createRespond } from '../../src/lib/http/respond.mjs'
import { startStreamWorkers, streamWorkerPool } from '../../src/lib/transport/stream-workers.mjs'
import { cancelWorkerRequest } from '../../src/lib/transport/go-worker-client.mjs'
import { startSchedulingSnapshot, stopSchedulingSnapshots } from '../../src/lib/vm/scheduling-snapshot.mjs'
import { openAIRuntimeSignals } from '../../src/lib/pool/openai-account-runtime.mjs'
import { buildVmList } from '../../src/lib/admin/panel-api.mjs'
import { UsageLogsView } from '../../src/lib/db/repos/usage-logs-view.mjs'

const root = process.env.KIN_PROJECT_ROOT
if (!root || !path.basename(root).startsWith('vm2api-bench-')) throw new Error('isolated benchmark root required')
const workers = Number(process.env.BENCH_WORKERS || 0)
const db = openDatabase({ dbPath: path.join(root, 'kin.db') })
const log = new RequestLogStore({
  db,
  dataDir: root,
  mode: process.env.BENCH_LOG_MODE || 'normal',
  maxMb: Number(process.env.BENCH_LOG_MAX_MB || 2048),
})
if (workers) log.enableReader(path.join(root, 'kin.db'))
const upstream = new Worker(new URL('./performance-upstream.mjs', import.meta.url), {
  workerData: {
    root,
    options: {
      delayMs: 50,
      chunks: Math.ceil(Number(process.env.BENCH_STREAM_MS || 3000) / 100),
      intervalMs: 100,
      chunkChars: Number(process.env.BENCH_CHUNK_CHARS || 0),
    },
  },
})
const { socketPath, tokenPath } = await new Promise((resolve, reject) => {
  upstream.once('message', resolve)
  upstream.once('error', reject)
})
const ids = Array.from({ length: 40 }, (_, i) => `vm-bench-${i}`)
for (const id of ids) {
  fs.mkdirSync(path.join(root, 'vms', id), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'vms', `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      platform: 'openai',
      family: 'codex',
      status: 'running',
      schedulable: true,
      policy: { maxConcurrency: 16, concurrencyOverride: true },
      codex: { has_access: true },
      proxy: { id: 'local', kind: 'local', scheme: 'local' },
      runtime: { codex_kernel_socket: socketPath, worker_token_file: tokenPath },
    }),
  )
}
if (workers) startSchedulingSnapshot(root)
const routing = { codex: { quota: { max_concurrency: 16 } }, sticky: { enabled: true } }
const stickyRouter = new StickyRouter({ db, config: routing })
const accountQuota = new AccountQuota({ db, config: routing, accounts: [] })
const sessions = new SessionLimitRegistry()
const cfg = { paths: { project: root }, rewrite: { enabled: false } }
const { json, writeSSEHeaders, readBody } = createRespond(cfg)
const stats = { requests: 0, errors: 0, by_route: {} }
const history = Number(process.env.BENCH_HISTORY || 10000)
db.exec('BEGIN')
for (let i = 0; i < history; i++)
  log.finish(log.start({ headers: { 'x-request-id': `history-${i}`, 'x-kin-log': 'normal' } }), {
    vm_id: ids[i % ids.length],
    status: 200,
    first_token_ms: i % 200,
    model: 'gpt-6.1-sol',
    usage: { input_tokens: 100, output_tokens: 30 },
  })
db.exec('COMMIT')
const debugHistory = Number(process.env.BENCH_DEBUG_HISTORY || 0)
// Separate transactions avoid holding one giant write lock while seeding GBs.
for (let i = 0; i < debugHistory; i++) {
  log.repo.insertDebug(`history-${i}`, new Date(Date.now() - 86400_000).toISOString(), { blob: 'd'.repeat(400000) })
}
if (workers) log.enableWriter(path.join(root, 'kin.db'))
await startStreamWorkers({ size: workers, cancel: cancelWorkerRequest })
const lag = monitorEventLoopDelay({ resolution: 10 })
lag.enable()
const dispatchDelays = []
const serverFirstToken = []
const p95 = (values) => (values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] : null)
let peakInflight = 0,
  maxSlotInflight = 0,
  cleanupRuns = 0
const cleanupMs = Number(process.env.BENCH_CLEANUP_MS || 0)
const cleanupTimer = cleanupMs
  ? setInterval(() => {
      cleanupRuns++
      log.cleanup()
    }, cleanupMs)
  : null
const sample = setInterval(() => {
  const counts = ids.map((id) => openAIRuntimeSignals(id).inFlight)
  peakInflight = Math.max(
    peakInflight,
    counts.reduce((a, b) => a + b, 0),
  )
  maxSlotInflight = Math.max(maxSlotInflight, ...counts)
}, 20)
const server = http.createServer(async (req, res) => {
  const requestAt = performance.now()
  const respond = (value) => {
    res.setHeader('x-bench-handler-ms', String(performance.now() - requestAt))
    return json(res, 200, value)
  }
  try {
    if (req.url === '/healthz') return json(res, 200, { ok: true })
    if (req.url === '/metrics') {
      await log.writer?.flush()
      await log.details?.flush()
      return json(res, 200, {
        ...stats,
        peakInflight,
        maxSlotInflight,
        remaining: ids.reduce((n, id) => n + openAIRuntimeSignals(id).inFlight, 0),
        loopP95Ms: lag.percentile(95) / 1e6,
        loopMaxMs: lag.max / 1e6,
        logs: log.count() - history,
        runtime: streamWorkerPool()?.snapshot() || null,
        rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        cleanupRuns,
        logWriter: { fallbacks: log.writer?.fallbacks || 0 },
        debugWriter: log.details?.snapshot() || null,
        debugBytes: log.repo.debugBytes(),
        dispatchP95Ms: p95(dispatchDelays),
        serverFirstTokenP95Ms: p95(serverFirstToken),
      })
    }
    if (req.url === '/api/panel/vms') {
      return respond(await buildVmList({ cfg, accountQuota, routingConfig: routing, requestLog: log }))
    }
    if (req.url === '/api/panel/request-logs/stats') {
      const since = new Date(Date.now() - 3600_000).toISOString()
      return respond({
        totals: await log.read('totals'),
        buckets: await log.read('aggregate', { since, bucket: 'minute' }),
        window: await log.read('windowStats', { since }),
        config: await log.snapshotAsync(),
      })
    }
    if (req.url === '/api/panel/usage-logs') {
      return respond(workers ? await log.readView('view', 'listBatch', {}) : new UsageLogsView(db).listBatch({}))
    }
    if (req.url !== '/v1/responses' || req.headers.authorization !== 'Bearer benchmark-only') return json(res, 401, {})
    req.apiKeyKind = 'master'
    const body = await readBody(req, 1024 * 1024)
    const ctx = log.start(req, { protocol: 'openai.responses', pathName: req.url })
    log.tapResponse(ctx, res)
    const bag = { model: body.model, stream: true, inbound_body: body }
    res.once('finish', () => {
      log.finish(ctx, { ...bag, status: res.statusCode })
      if (Number.isFinite(bag.first_token_ms)) serverFirstToken.push(bag.first_token_ms)
    })
    await handleCodexProtocol({
      req,
      res,
      protocol: 'openai.responses',
      ctx: { body, path: req.url },
      inbound: body,
      logBag: bag,
      stats,
      json,
      writeSSEHeaders,
      routing,
      projectRoot: root,
      stickyRouter,
      sessions,
      requestStartedAt: ctx.t0,
      captureOutbound: ctx.capture_outbound,
      // Docker lifecycle is deliberately simulated. Every byte still traverses
      // the production socket client, SSE parser, protocol handler and scheduler.
      ops: {
        writeCodexKernelConfig: () => {},
        ensureCodexKernel: async () => {
          dispatchDelays.push(Date.now() - ctx.t0)
          return { ok: true }
        },
      },
    })
  } catch (error) {
    stats.errors++
    if (!res.headersSent) json(res, 500, { error: error.message })
    else res.end()
  }
})
server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }))
process.on('message', async (message) => {
  if (message !== 'stop') return
  await new Promise((resolve) => server.close(resolve))
  clearInterval(sample)
  clearInterval(cleanupTimer)
  lag.disable()
  await streamWorkerPool()?.close()
  await log.closeWriter()
  await log.closeReader()
  stopSchedulingSnapshots()
  await upstream.terminate()
  closeDatabase()
  process.exit(0)
})
