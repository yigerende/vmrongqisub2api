import crypto from 'node:crypto'
import { managedCodex } from '../vm/runtime-kind.mjs'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { VmQualityRepo } from '../db/repos/vm-quality-repo.mjs'
import { withTransaction } from '../db/database.mjs'
import { DEFAULT_QUALITY_CONFIG, evaluateQuality, validateQualityConfig } from './vm-quality-config.mjs'
import { qualityIdentity, qualityOwnsPause, qualityScheduleVersion } from './vm-quality-identity.mjs'

export { qualityIdentity } from './vm-quality-identity.mjs'

const CONFIG_KEY = 'vm_quality_config'
const REVISION_KEY = 'vm_quality_revision'

export function createVmQualityMonitor({
  db,
  listTargets,
  getTarget,
  runProbe,
  changeSchedule,
  now = Date.now,
  onError = console.error,
}) {
  const settings = new SettingsRepo(db)
  const repo = new VmQualityRepo(db)
  let config = validateQualityConfig(settings.get(CONFIG_KEY, DEFAULT_QUALITY_CONFIG))
  let revision = settings.get(REVISION_KEY, null) || crypto.randomUUID()
  settings.set(REVISION_KEY, revision)
  let timer = null
  let stopped = false
  const pending = new Map()
  let active = 0
  const tasks = new Set()
  const current = getTarget || ((id) => listTargets().find((v) => v.id === id))
  const stateFor = (vm) => {
    const state = repo.ensure(vm.id, qualityIdentity(vm), config.default_enabled)
    const version = qualityScheduleVersion(vm)
    if (state.schedule_version === version) return state
    // A manual toggle or another scheduling writer starts a fresh streak.
    repo.streaks(vm.id, 0, 0, version)
    return repo.get(vm.id)
  }

  function snapshot(vm, limit = 16, full = false) {
    const state = stateFor(vm)
    const job = pending.get(vm.id)
    return {
      enabled: !!state.enabled,
      running: !!job && job.identity === state.identity,
      next_at: state.next_at || null,
      failure_streak: state.failure_streak,
      recovery_streak: state.recovery_streak,
      paused_by_quality: qualityOwnsPause(vm, state.identity),
      // Polling the fleet must not transfer every long model answer. Details are on demand.
      history: repo.history(vm.id, limit).map((result) => {
        if (full) return result
        const { answer, expected_answer, ...summary } = result
        return summary
      }),
    }
  }

  function setConfig(input) {
    const next = validateQualityConfig(input)
    const changed =
      JSON.stringify({ ...config, default_enabled: false }) !== JSON.stringify({ ...next, default_enabled: false })
    const nextRevision = changed ? crypto.randomUUID() : revision
    withTransaction(db, () => {
      settings.set(CONFIG_KEY, next)
      settings.set(REVISION_KEY, nextRevision)
      if (changed) repo.reschedule()
    })
    config = next
    revision = nextRevision
    for (const id of repo.ids()) repo.trim(id, config.history_limit)
    return structuredClone(config)
  }

  function setEnabled(ids, enabled, all = false) {
    if (typeof enabled !== 'boolean') throw new Error('enabled 必须为布尔值')
    const vms = listTargets()
    const targets = all ? vms : vms.filter((v) => ids.includes(v.id))
    if (!all && targets.length !== new Set(ids).size) throw Object.assign(new Error('槽位不存在'), { status: 404 })
    for (const vm of targets) {
      stateFor(vm)
      repo.enable(vm.id, enabled)
      // Let an in-flight probe finish and keep its record; cancel only queued automatic work.
      const job = pending.get(vm.id)
      if (!enabled && job?.source === 'auto' && !job.started) pending.delete(vm.id)
    }
    if (all) setConfig({ ...config, default_enabled: enabled })
    return { count: targets.length, enabled }
  }

  async function execute(job) {
    try {
      const vm = current(job.id)
      if (!vm || qualityIdentity(vm) !== job.identity) return
      const state = stateFor(vm)
      if (job.source === 'auto' && (!state.enabled || vm.status !== 'running' || !vm.has_token)) return
      const q = structuredClone(config)
      const runRevision = revision
      const runScheduleVersion = qualityScheduleVersion(vm)
      const questions = q.questions.filter((item) => item.enabled)
      const question = questions[state.question_cursor % questions.length]
      const startedAt = now()
      let probe
      try {
        probe = await runProbe({ vm, config: q, question, signal: job.controller.signal })
      } catch (error) {
        probe = { ok: false, error: { message: error.message }, duration_ms: now() - startedAt }
      }
      if (stopped) return
      const latest = current(job.id)
      if (!latest || qualityIdentity(latest) !== job.identity) return
      const verdict = evaluateQuality(q, question, probe)
      const result = {
        ...verdict,
        revision: runRevision,
        started_at: new Date(startedAt).toISOString(),
        source: job.source,
        checked_at: new Date(now()).toISOString(),
        question_id: question.id,
        question_name: question.name,
        expected_answer: question.answer,
        model: probe.model || (vm.platform === 'openai' ? q.model : q.claude_model),
        response_model: probe.response_model || null,
        mode: q.mode,
        max_duration_ms: question.max_duration_ms,
      }
      const interval = verdict.status === 'normal' ? q.interval_seconds : q.retry_seconds
      const recorded = repo.record(
        job.id,
        job.identity,
        result,
        runRevision === revision ? now() + interval * 1000 : 0,
        verdict.status === 'error' ? state.question_cursor : state.question_cursor + 1,
        config.history_limit,
      )
      const latestState = stateFor(latest)
      // Keep stale samples for history only. An operator edit wins over an in-flight probe.
      if (
        recorded &&
        runRevision === revision &&
        runScheduleVersion === qualityScheduleVersion(latest) &&
        config.pause_on_degraded &&
        (job.source === 'manual' || latestState.enabled)
      ) {
        applyScheduleResult(latest, latestState, verdict.status)
      }
    } catch (error) {
      onError('[vm-quality]', error)
    } finally {
      active--
      if (pending.get(job.id) === job) pending.delete(job.id)
      drain()
    }
  }

  function applyScheduleResult(vm, state, status) {
    if (status === 'error') return // Yellow does not increment or break either streak.
    const failures = status === 'degraded' ? Math.min(state.failure_streak + 1, 1000) : 0
    const recoveries = status === 'normal' ? Math.min(state.recovery_streak + 1, 1000) : 0
    repo.streaks(vm.id, failures, recoveries, qualityScheduleVersion(vm))
    if (!changeSchedule || vm.status !== 'running' || !vm.has_token) return
    const pause = status === 'degraded' && failures >= config.failure_limit && vm.schedulable !== false
    const resume = status === 'normal' && recoveries >= config.recovery_limit && qualityOwnsPause(vm, state.identity)
    if (!pause && !resume) return
    const changed = changeSchedule(vm, resume)
    if (changed) repo.streaks(vm.id, failures, recoveries, qualityScheduleVersion(changed))
  }

  function drain() {
    if (stopped) return
    for (const job of pending.values()) {
      if (active >= config.concurrency) break
      if (job.started) continue
      job.started = true
      active++
      const task = execute(job)
      tasks.add(task)
      void task.finally(() => tasks.delete(task))
    }
  }

  function enqueue(id, source = 'manual', knownVm = null) {
    if (stopped) throw Object.assign(new Error('检测服务已停止'), { status: 503 })
    const vm = knownVm || current(id)
    if (!vm) throw Object.assign(new Error('槽位不存在'), { status: 404 })
    const state = stateFor(vm)
    const previous = pending.get(id)
    if (previous) return { queued: false, running: true }
    if (pending.size >= 2000) throw Object.assign(new Error('检测队列已满，请稍后重试'), { status: 429 })
    pending.set(id, { id, identity: state.identity, source, started: false, controller: new AbortController() })
    // Respond to manual requests immediately; they share the automatic concurrency limit.
    queueMicrotask(drain)
    return { queued: true, running: true }
  }

  function tick() {
    if (stopped) return
    try {
      const vms = listTargets()
      const ids = new Set(vms.map((v) => v.id))
      for (const id of repo.ids()) if (!ids.has(id)) repo.remove(id)
      for (const [id, job] of pending) {
        const vm = vms.find((v) => v.id === id)
        if (!vm || qualityIdentity(vm) !== job.identity) {
          job.controller.abort()
          if (!job.started) pending.delete(id)
        }
      }
      for (const vm of vms) {
        const state = stateFor(vm)
        if (state.enabled && vm.status === 'running' && vm.has_token && state.next_at <= now() && !pending.has(vm.id))
          enqueue(vm.id, 'auto', vm)
      }
    } catch (error) {
      onError('[vm-quality]', error)
    }
  }

  return {
    getConfig: () => structuredClone(config),
    setConfig,
    setEnabled,
    snapshot,
    enqueue,
    tick,
    results(slots) {
      if (
        !Array.isArray(slots) ||
        slots.length < 1 ||
        slots.length > 100 ||
        slots.some(
          (slot) =>
            !slot ||
            typeof slot.id !== 'string' ||
            !/^[a-zA-Z0-9_-]+$/.test(slot.id) ||
            typeof slot.assignment_id !== 'string' ||
            !slot.assignment_id ||
            slot.assignment_id.length > 256,
        ) ||
        new Set(slots.map((slot) => slot.id)).size !== slots.length
      )
        throw new Error('slots 必须包含 1 至 100 个不同槽位及其 assignment_id')
      return {
        version: 1,
        server_now: new Date(now()).toISOString(),
        revision,
        slots: slots.map(({ id, assignment_id }) => {
          const vm = current(id)
          if (!vm) return { id, error: 'not_found' }
          if (vm.assignment_id !== assignment_id || !managedCodex(vm)) return { id, error: 'assignment_mismatch' }
          const state = repo.get(id)
          const identity = qualityIdentity(vm)
          const latest = state?.identity === identity ? repo.history(id, 1)[0] : null
          // Reading results neither creates state nor queues inference. Old histories remain
          // visible in the panel, but cannot drive Space actions under a new config/identity.
          const result = latest
            ? { ...latest, answer: String(latest.answer || '').slice(0, 4000), expected_answer: undefined }
            : null
          return {
            id,
            assignment_id,
            identity,
            enabled: !!state?.enabled,
            running: pending.has(id),
            current: !!result && result.revision === revision,
            result,
          }
        }),
      }
    },
    history(id) {
      const vm = current(id)
      if (!vm) throw Object.assign(new Error('槽位不存在'), { status: 404 })
      return snapshot(vm, config.history_limit, true)
    },
    start() {
      if (timer) return
      stopped = false
      timer = setInterval(tick, 5000)
      timer.unref?.()
      tick()
    },
    stop() {
      stopped = true
      clearInterval(timer)
      timer = null
      for (const job of pending.values()) job.controller.abort()
      pending.clear()
    },
    async idle() {
      await new Promise((resolve) => queueMicrotask(resolve))
      while (tasks.size) await Promise.all([...tasks])
    },
  }
}
