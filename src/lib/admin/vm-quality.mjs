import crypto from 'node:crypto'
import { SettingsRepo } from '../db/repos/settings-repo.mjs'
import { VmQualityRepo } from '../db/repos/vm-quality-repo.mjs'
import { DEFAULT_QUALITY_CONFIG, evaluateQuality, validateQualityConfig } from './vm-quality-config.mjs'

const CONFIG_KEY = 'vm_quality_config'

// Token refresh and proxy changes do not change account identity. Reset/replacement does.
export function qualityIdentity(vm) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        vm.created_at,
        vm.assignment_id,
        vm.fingerprint?.guest_machine_id,
        vm.org_uuid,
        vm.account_uuid,
        vm.email,
      ]),
    )
    .digest('hex')
}

export function createVmQualityMonitor({
  db,
  listTargets,
  getTarget,
  runProbe,
  now = Date.now,
  onError = console.error,
}) {
  const settings = new SettingsRepo(db)
  const repo = new VmQualityRepo(db)
  let config = validateQualityConfig(settings.get(CONFIG_KEY, DEFAULT_QUALITY_CONFIG))
  let revision = crypto.randomUUID()
  let timer = null
  let stopped = false
  const pending = new Map()
  let active = 0
  const tasks = new Set()
  const current = getTarget || ((id) => listTargets().find((v) => v.id === id))
  const stateFor = (vm) => repo.ensure(vm.id, qualityIdentity(vm), config.default_enabled)

  function snapshot(vm, limit = 16, full = false) {
    const state = stateFor(vm)
    const job = pending.get(vm.id)
    return {
      enabled: !!state.enabled,
      running: !!job && job.identity === state.identity,
      next_at: state.next_at || null,
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
    config = next
    settings.set(CONFIG_KEY, config)
    if (changed) {
      revision = crypto.randomUUID()
      repo.reschedule()
    }
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
      repo.record(
        job.id,
        job.identity,
        result,
        runRevision === revision ? now() + interval * 1000 : 0,
        verdict.status === 'error' ? state.question_cursor : state.question_cursor + 1,
        config.history_limit,
      )
    } catch (error) {
      onError('[vm-quality]', error)
    } finally {
      active--
      if (pending.get(job.id) === job) pending.delete(job.id)
      drain()
    }
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
