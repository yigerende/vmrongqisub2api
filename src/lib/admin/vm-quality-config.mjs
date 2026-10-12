import { runInNewContext } from 'node:vm'

export const DEFAULT_QUALITY_CONFIG = {
  model: 'gpt-5.4',
  claude_model: 'claude-sonnet-4-6',
  reasoning_effort: 'xhigh',
  mode: 'content_time',
  interval_seconds: 300,
  retry_seconds: 60,
  concurrency: 4,
  timeout_seconds: 180,
  history_limit: 200,
  default_enabled: false,
  questions: [
    {
      id: 'candy',
      name: '糖果配对',
      enabled: true,
      prompt:
        '直接回答问题，不允许联网搜索、调用命令或代码。糖果数量为：圆形苹果7、桃子9、西瓜8；五角星苹果7、桃子6、西瓜4。形状可用手感分辨，口味未知。可以事先决定分别摸几个圆形和几个五角星，不放回取出。至少总共取多少颗，才能保证有圆苹果与星桃子，或圆桃子与星苹果的一组？只回复数字。',
      answer: '21',
      match_mode: 'answer',
      max_duration_ms: 20000,
    },
    {
      id: 'clock',
      name: '时钟夹角',
      enabled: true,
      prompt: '连续走动的指针式时钟在3点15分时，时针与分针较小夹角是多少度？只回复数字，不带单位。',
      answer: '7.5',
      match_mode: 'answer',
      max_duration_ms: 20000,
    },
    {
      id: 'percent',
      name: '百分比变化',
      enabled: true,
      prompt: '一个数先增加20%，再在增加后的数值基础上减少20%，最终是原数的百分之多少？只回复数字，不带百分号。',
      answer: '96',
      match_mode: 'answer',
      max_duration_ms: 20000,
    },
  ],
}

export function validateQualityConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('检测配置必须是对象')
  const q = { ...structuredClone(DEFAULT_QUALITY_CONFIG), ...input }
  for (const key of ['model', 'claude_model']) {
    if (typeof q[key] !== 'string' || !q[key].trim() || q[key].length > 200) throw new Error('请输入检测模型')
    q[key] = q[key].trim()
  }
  if (!['low', 'medium', 'high', 'xhigh'].includes(q.reasoning_effort)) throw new Error('推理强度无效')
  if (!['content', 'time', 'content_time'].includes(q.mode)) throw new Error('判断方式无效')
  if (typeof q.default_enabled !== 'boolean') throw new Error('新增账号开关无效')
  for (const [key, min, max] of [
    ['interval_seconds', 10, 86400],
    ['retry_seconds', 10, 86400],
    ['concurrency', 1, 32],
    ['timeout_seconds', 5, 300],
    ['history_limit', 1, 1000],
  ]) {
    if (!Number.isInteger(q[key]) || q[key] < min || q[key] > max) throw new Error(`${key} 必须为 ${min}–${max} 的整数`)
  }
  if (!Array.isArray(q.questions) || !q.questions.length || q.questions.length > 50)
    throw new Error('题库需要 1–50 道题目')
  const ids = new Set()
  q.questions = q.questions.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('题目无效')
    for (const [key, max] of [
      ['id', 80],
      ['name', 200],
      ['prompt', 15000],
      ['answer', 2000],
    ]) {
      if (typeof item[key] !== 'string' || item[key].length > max || (key !== 'answer' && !item[key].trim()))
        throw new Error('题目 ID、名称、内容或答案无效')
    }
    if (ids.has(item.id)) throw new Error('题目 ID 不能重复')
    ids.add(item.id)
    if (typeof item.enabled !== 'boolean') throw new Error('题目开关无效')
    if (q.mode !== 'time' && !item.answer.trim()) throw new Error('请输入预期答案')
    if (!Number.isInteger(item.max_duration_ms) || item.max_duration_ms < 1 || item.max_duration_ms > 300000)
      throw new Error('耗时阈值必须为 1–300000 毫秒')
    if (!['answer', 'keyword', 'regex'].includes(item.match_mode)) throw new Error('答案匹配方式无效')
    if (item.match_mode === 'regex') {
      try {
        new RegExp(item.answer)
      } catch {
        throw new Error('答案正则表达式无效')
      }
    }
    return Object.fromEntries(
      ['id', 'name', 'enabled', 'prompt', 'answer', 'match_mode', 'max_duration_ms'].map((k) => [k, item[k]]),
    )
  })
  if (!q.questions.some((item) => item.enabled)) throw new Error('请至少启用一道题目')
  return Object.fromEntries(Object.keys(DEFAULT_QUALITY_CONFIG).map((key) => [key, q[key]]))
}

export function qualityAnswerMatch(question, text) {
  if (question.match_mode === 'keyword') return text.includes(question.answer)
  if (question.match_mode === 'regex') {
    // Bound regex CPU time as well as input size; a configured regex must not block the gateway.
    return runInNewContext(
      'new RegExp(pattern).test(answer)',
      { pattern: question.answer, answer: text },
      { timeout: 50 },
    )
  }
  const finals = [...text.trim().matchAll(/^\s*FINAL_ANSWER\s*=\s*([^\r\n]+)\s*$/gm)]
  return finals.length === 1
    ? finals[0][1].trim() === question.answer.trim()
    : finals.length === 0 && text.trim() === question.answer.trim()
}

export function evaluateQuality(config, question, probe) {
  const answer = String(probe?.text || '')
  const duration = Number(probe?.duration_ms) || 0
  if (!probe?.ok || probe.complete !== true || !answer.trim() || answer.length > 16384) {
    return {
      status: 'error',
      reason: String(probe?.error?.message || '响应为空、不完整或过长').slice(0, 500),
      duration_ms: duration,
    }
  }
  try {
    const content = qualityAnswerMatch(question, answer)
    const time = duration >= 0 && duration < question.max_duration_ms
    const passed = config.mode === 'time' ? time : config.mode === 'content' ? content : content && time
    return {
      status: passed ? 'normal' : 'degraded',
      answer,
      duration_ms: duration,
      content_passed: content,
      time_passed: time,
      reason: `答案${content ? '匹配' : '不匹配'}；耗时 ${duration}ms，阈值 <${question.max_duration_ms}ms`,
    }
  } catch {
    return { status: 'error', reason: '答案正则执行超时，请简化表达式', duration_ms: duration }
  }
}
