import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { runVmQualityProbe } from '../../src/lib/admin/vm-quality-probe.mjs'
import { DEFAULT_QUALITY_CONFIG, evaluateQuality } from '../../src/lib/admin/vm-quality-config.mjs'

async function serve(t, respond) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    calls.push({ headers: req.headers, path: req.url, body: JSON.parse(Buffer.concat(chunks)) })
    respond(res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { calls, baseUrl: `http://127.0.0.1:${server.address().port}` }
}
const event = (data) => `data: ${JSON.stringify(data)}\n\n`
const options = {
  vm: { id: 'vm-local', platform: 'openai', proxy: { id: 'px-local' } },
  config: DEFAULT_QUALITY_CONFIG,
  question: DEFAULT_QUALITY_CONFIG.questions[0],
  apiKey: 'test-key',
}

test('GPT detection pins exact local slot, bypasses health cache, uses saved model/prompt/effort and a fresh session', async (t) => {
  const { calls, baseUrl } = await serve(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      event({ type: 'response.output_text.delta', delta: '21' }) +
        event({ type: 'response.completed', response: { status: 'completed', model: 'gpt-5.4' } }),
    )
  })
  const result = await runVmQualityProbe({ ...options, baseUrl })
  assert.equal(evaluateQuality(options.config, options.question, result).status, 'normal')
  assert.equal(calls[0].path, '/v1/responses')
  assert.equal(calls[0].headers['x-kin-vm'], options.vm.id)
  assert.equal(calls[0].headers['x-kin-health-real'], '1')
  assert.equal(calls[0].body.model, options.config.model)
  assert.equal(calls[0].body.reasoning.effort, options.config.reasoning_effort)
  assert.match(JSON.stringify(calls[0].body.input), /糖果/)
  await runVmQualityProbe({ ...options, baseUrl })
  assert.notEqual(calls[0].headers['session-id'], calls[1].headers['session-id'])
})

test('partial/error/incomplete/oversized responses are yellow even when the partial answer matches', async (t) => {
  for (const body of [
    event({ type: 'response.output_text.delta', delta: '21' }),
    event({ type: 'response.output_text.delta', delta: '21' }) + event({ type: 'response.incomplete' }),
    event({ type: 'response.failed', response: { error: { message: 'rate limit' } } }),
    event({ type: 'response.output_text.delta', delta: 'a'.repeat(2 * 1024 * 1024) }),
  ]) {
    const { baseUrl } = await serve(t, (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(body)
    })
    const result = await runVmQualityProbe({ ...options, baseUrl })
    assert.equal(evaluateQuality(options.config, options.question, result).status, 'error')
  }
})

test('Claude stream requires message_stop and end_turn and uses configured Claude model', async (t) => {
  const { calls, baseUrl } = await serve(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(
      event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '21' } }) +
        event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) +
        event({ type: 'message_stop' }),
    )
  })
  const result = await runVmQualityProbe({ ...options, vm: { ...options.vm, platform: 'anthropic' }, baseUrl })
  assert.equal(result.complete, true)
  assert.equal(calls[0].path, '/v1/messages')
  assert.equal(calls[0].body.model, options.config.claude_model)
})

test('HTTP failure and cancellation are request failures, not degradation', async (t) => {
  const { baseUrl } = await serve(t, (res) => {
    res.writeHead(429, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'quota exceeded' } }))
  })
  const result = await runVmQualityProbe({ ...options, baseUrl })
  assert.equal(result.ok, false)
  assert.equal(evaluateQuality(options.config, options.question, result).status, 'error')
  const controller = new AbortController()
  const stalled = await serve(t, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': waiting\n\n')
  })
  const promise = runVmQualityProbe({ ...options, baseUrl: stalled.baseUrl, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  assert.equal((await promise).ok, false)
})
