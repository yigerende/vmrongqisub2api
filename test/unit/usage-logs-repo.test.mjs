import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDatabase } from '../../src/lib/db/database.mjs'
import { UsageLogsRepo } from '../../src/lib/db/repos/usage-logs-repo.mjs'
import { codexBodyToAnthropicMessage } from '../../src/lib/protocol/codex-convert.mjs'

let seq = 0

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kin-ulrepo-'))
  const db = createDatabase({ dbPath: path.join(dir, 'logs.db') })
  db.exec(`
    INSERT INTO users (id, email, username, password_hash) VALUES ('u1', 'a@x', 'alice', 'x'), ('u2', 'b@x', 'bob', 'x');
    INSERT INTO api_keys (id, name, key, user_id) VALUES ('k1', 'alice-key', 'sk-1', 'u1'), ('k2', 'bob-key', 'sk-2', 'u2');
    INSERT INTO vms (id, name, vm_json) VALUES ('vm-a', 'Slot A', '{}');
  `)
  return { dir, db, repo: new UsageLogsRepo(db) }
}

function seed(repo, rows) {
  for (const r of rows) {
    seq++
    repo.insertSummary({
      id: `log_${seq}`,
      request_id: `req-${seq}`,
      created_at: new Date().toISOString(),
      log_mode: 'normal',
      method: 'POST',
      path: '/v1/messages',
      status: 200,
      model: 'claude-sonnet-4',
      ...r,
    })
  }
}

function assertHit(stats, prompt, read, label) {
  assert.equal(Number(stats.prompt_tokens), prompt, `${label} prompt_tokens`)
  assert.equal(Number(stats.cache_read_tokens), read, `${label} cache_read_tokens`)
  assert.equal(stats.cache_hit_rate, prompt > 0 ? read / prompt : null, `${label} cache_hit_rate`)
}

test('mixed Claude/Codex usage keeps a row-wise prompt denominator on totals and windows', () => {
  const { db, repo } = freshDb()
  try {
    seed(repo, [
      {
        user_id: 'u1',
        api_key_id: 'k1',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        input_tokens: 5,
        cache_read_tokens: 95,
      },
      {
        user_id: 'u1',
        api_key_id: 'k1',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        via: 'codex-kernel',
        model: 'gpt-5.4',
        input_tokens: 100,
        cache_read_tokens: 95,
      },
      {
        user_id: 'u2',
        api_key_id: 'k2',
        input_tokens: 50,
        cache_read_tokens: 50,
      },
    ])
    assertHit(repo.totals(), 300, 240, 'totals')
    assertHit(repo.billingStats().total, 300, 240, 'billing.total')
    const since = new Date(Date.now() - 60_000).toISOString()
    assertHit(repo.windowStats({ since }), 300, 240, 'window')
    assertHit(repo.windowStats({ since, owner_user_id: 'u1' }), 200, 190, 'owner window')
    assertHit(repo.windowStats({ since, owner_user_id: 'u2' }), 100, 50, 'other owner')
  } finally {
    db.close()
  }
})

test('empty usage windows keep a null cache hit rate', () => {
  const { db, repo } = freshDb()
  try {
    assertHit(repo.totals(), 0, 0, 'empty totals')
    assertHit(repo.billingStats().total, 0, 0, 'empty billing')
    const empty = repo.windowStats({ since: '2099-01-01T00:00:00.000Z' })
    assert.equal(empty.requests, 0)
    assertHit(empty, 0, 0, 'empty window')
  } finally {
    db.close()
  }
})

test('aligned account windows re-sum per-row prompt tokens instead of mixed Anthropic formula', () => {
  const { db, repo } = freshDb()
  try {
    const now = Date.parse('2026-09-26T12:00:00.000Z')
    seed(repo, [
      {
        created_at: '2026-09-26T10:00:00.000Z',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        input_tokens: 5,
        cache_read_tokens: 0,
        cache_creation_tokens: 10_000,
      },
      {
        created_at: '2026-09-26T11:30:00.000Z',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        input_tokens: 5,
        cache_read_tokens: 95,
      },
      {
        created_at: '2026-09-26T11:45:00.000Z',
        vm_id: 'vm-a',
        account_id: 'acc-1',
        via: 'codex-kernel',
        model: 'gpt-5.4',
        input_tokens: 100,
        cache_read_tokens: 95,
      },
    ])
    const aligned = repo.billingStats({
      now,
      accountWindows: [{ account_id: 'acc-1', vm_id: 'vm-a', reset_5h: '2026-09-26T16:00:00.000Z' }],
    })
    assertHit(aligned.window_5h, 200, 190, 'aligned 5h')
    assert.equal(Number(aligned.accounts[0].window_5h.prompt_tokens), 200)
    assert.equal(Number(aligned.accounts[0].window_5h.cache_read_tokens), 190)
    const rolling = repo.billingStats({ now })
    assertHit(rolling.window_5h, 10_205, 190, 'rolling 5h')
  } finally {
    db.close()
  }
})

test('converted non-streaming Anthropic API usage stays disjoint in UsageLogsRepo totals', () => {
  const { db, repo } = freshDb()
  try {
    const upstream = {
      model: 'gpt-5.4',
      output: [],
      usage: {
        input_tokens: 100,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 80, cache_write_tokens: 0 },
      },
    }
    const message = codexBodyToAnthropicMessage(upstream)
    seed(repo, [
      {
        user_id: 'u1',
        via: 'api-kernel',
        protocol: 'anthropic.messages',
        stream: false,
        model: 'claude-sonnet-4',
        upstream_model: upstream.model,
        pricing_model: 'unpriced',
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_read_tokens: message.usage.cache_read_input_tokens,
        cache_creation_tokens: message.usage.cache_creation_input_tokens,
      },
      {
        user_id: 'u1',
        via: 'codex-kernel',
        model: 'gpt-5.4',
        input_tokens: 100,
        cache_read_tokens: 80,
      },
    ])
    assert.equal(message.usage.input_tokens, 20)
    assert.equal(message.usage.cache_read_input_tokens, 80)
    assertHit(repo.totals(), 200, 160, 'converted+codex totals')
  } finally {
    db.close()
  }
})
