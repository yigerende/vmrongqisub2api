export type QualityQuestion = {
  id: string
  name: string
  enabled: boolean
  prompt: string
  answer: string
  match_mode: 'answer' | 'keyword' | 'regex'
  max_duration_ms: number
}

export type QualityConfig = {
  model: string
  claude_model: string
  reasoning_effort: 'low' | 'medium' | 'high' | 'xhigh'
  mode: 'content' | 'time' | 'content_time'
  interval_seconds: number
  retry_seconds: number
  concurrency: number
  timeout_seconds: number
  history_limit: number
  default_enabled: boolean
  pause_on_degraded: boolean
  switch_groups_on_degraded: boolean
  degraded_group_ids: string[]
  failure_limit: number
  recovery_limit: number
  questions: QualityQuestion[]
}

export type QualityResult = {
  id: number
  status: 'normal' | 'error' | 'degraded'
  source: 'manual' | 'auto'
  checked_at: string
  question_name: string
  answer?: string
  expected_answer?: string
  reason: string
  duration_ms: number
  model: string
  response_model?: string | null
}

export type QualitySnapshot = {
  enabled: boolean
  running: boolean
  next_at: number | null
  failure_streak: number
  recovery_streak: number
  paused_by_quality: boolean
  groups_switched_by_quality: boolean
  group_action_error: string | null
  history: QualityResult[]
}
