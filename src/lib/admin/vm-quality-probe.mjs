import crypto from 'node:crypto'
import { isCodexVm } from '../vm/vm-kind.mjs'
import { codexTextInput } from '../protocol/codex-convert.mjs'
import { postV1Loopback } from './vm-test-chat.mjs'
import { HEALTH_REAL_HEADER } from './health-probe.mjs'

/** Real, pinned requests through the existing gateway. No lifecycle/scheduling writes. */
export async function runVmQualityProbe({ vm, config, question, baseUrl, apiKey, signal }) {
  const codex = isCodexVm(vm)
  const model = codex ? config.model : config.claude_model
  const session = `quality-${crypto.randomUUID()}`
  const inbound = codex
    ? {
        model,
        input: codexTextInput(question.prompt),
        reasoning: { effort: config.reasoning_effort },
        stream: true,
        store: false,
      }
    : { model, messages: [{ role: 'user', content: question.prompt }], max_tokens: 4096, stream: true }
  const started = Date.now()
  const result = await postV1Loopback({
    path: codex ? '/v1/responses' : '/v1/messages',
    baseUrl,
    apiKey,
    inbound,
    vmId: vm.id,
    headers: {
      'user-agent': 'kin-quality-probe/1.0',
      'anthropic-version': '2023-06-01',
      'session-id': session,
      'x-session-id': session,
      accept: 'text/event-stream',
    },
    extraHeaders: { [HEALTH_REAL_HEADER]: '1' },
    timeoutMs: config.timeout_seconds * 1000,
    maxResponseBytes: 2 * 1024 * 1024,
    signal,
  })
  return {
    ok: result.ok,
    complete: result.complete === true,
    text: result.text,
    duration_ms: Date.now() - started,
    model,
    response_model: result.model,
    error: result.ok ? null : { message: result.body?.error?.message || `请求失败 HTTP ${result.status}` },
  }
}
