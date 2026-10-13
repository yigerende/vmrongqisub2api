import { fork } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'

const arg = (name, fallback) => process.argv.find((item) => item.startsWith(`--${name}=`))?.split('=')[1] ?? fallback
const workers = Number(arg('workers', 8))
const seconds = Number(arg('seconds', 20))
const streamMs = Number(arg('stream-ms', 3000))
const levels = String(arg('levels', '200,400,500')).split(',').map(Number)
if (
  !Number.isInteger(workers) ||
  workers < 0 ||
  workers > 64 ||
  !(seconds > 0) ||
  !Number.isFinite(streamMs) ||
  streamMs < 100 ||
  streamMs > 120000 ||
  levels.some((n) => !Number.isInteger(n) || n < 1 || n > 1000)
)
  throw new Error('invalid benchmark options')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vm2api-bench-'))
const child = fork(new URL('../test/helpers/performance-gateway.mjs', import.meta.url), [], {
  env: {
    ...process.env,
    KIN_PROJECT_ROOT: root,
    KIN_CRS_MOCK: '0',
    BENCH_WORKERS: String(workers),
    BENCH_STREAM_MS: String(streamMs),
    BENCH_HISTORY: arg('history', 10000),
    BENCH_LOG_MODE: arg('log-mode', 'normal'),
    BENCH_DEBUG_HISTORY: arg('debug-history', 0),
    BENCH_BODY_CHARS: arg('body-chars', 2000),
    BENCH_CHUNK_CHARS: arg('chunk-chars', 0),
    BENCH_CLEANUP_MS: arg('cleanup-ms', 0),
    BENCH_LOG_MAX_MB: arg('log-max-mb', 2048),
  },
  execArgv: arg('profile', '') ? ['--cpu-prof', `--cpu-prof-dir=${path.resolve(arg('profile', ''))}`] : [],
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
})
const exit = new Promise((resolve) => child.once('exit', resolve))
const results = []
const bodyChars = Number(arg('body-chars', 2000))
const requestInput =
  arg('body-entropy', 'low') === 'high'
    ? randomBytes(Math.ceil((bodyChars * 3) / 4))
        .toString('base64')
        .slice(0, bodyChars)
    : 'b'.repeat(bodyChars)
let requests = 0
const percentile = (values, p) =>
  values.length
    ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]
    : null
try {
  const { port } = await new Promise((resolve, reject) => {
    child.once('message', resolve)
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`gateway exited ${code}`)))
  })
  const base = `http://127.0.0.1:${port}`
  for (const concurrency of levels) {
    const deadline = performance.now() + seconds * 1000
    const ttft = [],
      panel = [],
      failures = []
    let completed = 0,
      finished = false
    const routes = ['/api/panel/vms', '/api/panel/request-logs/stats', '/api/panel/usage-logs', '/healthz']
    const panelRun = Promise.all(
      routes.map(async (route) => {
        while (!finished) {
          const start = performance.now()
          try {
            const response = await fetch(base + route, { signal: AbortSignal.timeout(30000) })
            await response.text()
            panel.push({
              route,
              ms: performance.now() - start,
              status: response.status,
              handlerMs: Number(response.headers.get('x-bench-handler-ms') || 0),
            })
          } catch (error) {
            panel.push({ route, ms: performance.now() - start, status: 0, error: error.message })
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }),
    )
    await Promise.all(
      Array.from({ length: concurrency }, async (_, lane) => {
        do {
          const start = performance.now()
          try {
            const response = await fetch(base + '/v1/responses', {
              method: 'POST',
              headers: {
                authorization: 'Bearer benchmark-only',
                'content-type': 'application/json',
                'x-session-id': `lane-${concurrency}-${lane}`,
              },
              body: JSON.stringify({
                model: 'gpt-6.1-sol',
                input: requestInput,
                stream: true,
              }),
              signal: AbortSignal.timeout(streamMs + 60000),
            })
            let first = true,
              terminal = false,
              carry = ''
            for await (const chunk of response.body) {
              const text = Buffer.from(chunk).toString()
              const window = carry + text
              if (first && window.includes('response.output_text.delta')) {
                first = false
                ttft.push(performance.now() - start)
              }
              if (window.includes('response.completed')) terminal = true
              carry = window.slice(-128)
            }
            if (response.status !== 200 || !terminal) failures.push(response.status)
            else completed++
          } catch (error) {
            failures.push(`${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`)
            // Preserve the configured load shape after a failed connection;
            // do not turn a closed socket into an unbounded retry flood.
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
        } while (performance.now() < deadline)
      }),
    )
    finished = true
    await panelRun
    const metrics = await (await fetch(base + '/metrics')).json()
    requests += completed + failures.length
    const report = {
      workers,
      concurrency,
      seconds,
      streamMs,
      logMode: arg('log-mode', 'normal'),
      bodyChars: Number(arg('body-chars', 2000)),
      bodyEntropy: arg('body-entropy', 'low'),
      debugHistory: Number(arg('debug-history', 0)),
      completed,
      failures: failures.length,
      failureExamples: failures.slice(0, 3),
      ttftP95Ms: percentile(ttft, 0.95),
      // Includes client, socket, upstream fixture and OS scheduling delays;
      // this is an end-to-end figure, not pure gateway processing time.
      ttftAboveSimulatedDelayP95Ms: Math.max(0, percentile(ttft, 0.95) - 50),
      panelP95Ms: percentile(
        panel.map((p) => p.ms),
        0.95,
      ),
      panelFailures: panel.filter((p) => p.status !== 200).length,
      panelByRoute: Object.fromEntries(
        [...new Set(panel.map((p) => p.route))].map((route) => [
          route,
          {
            samples: panel.filter((p) => p.route === route).length,
            p95Ms: percentile(
              panel.filter((p) => p.route === route).map((p) => p.ms),
              0.95,
            ),
            handlerP95Ms: percentile(
              panel.filter((p) => p.route === route).map((p) => p.handlerMs),
              0.95,
            ),
          },
        ]),
      ),
      metrics,
    }
    results.push(report)
    console.log(JSON.stringify(report))
    if (
      failures.length ||
      report.panelFailures ||
      metrics.remaining ||
      metrics.logs !== requests ||
      metrics.maxSlotInflight > 16 ||
      metrics.debugWriter?.dropped_records ||
      report.ttftP95Ms > Number(arg('max-ttft-ms', Infinity)) ||
      metrics.dispatchP95Ms > Number(arg('max-dispatch-ms', Infinity)) ||
      metrics.loopMaxMs > Number(arg('max-loop-ms', Infinity)) ||
      Object.values(report.panelByRoute).some((route) => route.p95Ms > 1000)
    )
      process.exitCode = 1
  }
  const output = arg('output', '')
  if (output)
    fs.writeFileSync(
      path.resolve(output),
      JSON.stringify(
        { node: process.version, platform: process.platform, cpus: os.availableParallelism(), results },
        null,
        2,
      ) + '\n',
    )
} finally {
  child.send('stop')
  const timer = setTimeout(() => child.kill(), 10000)
  await exit
  clearTimeout(timer)
  fs.rmSync(root, { recursive: true, force: true })
}
