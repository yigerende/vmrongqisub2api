import crypto from 'node:crypto'
import { getVm, summarizeVm, patchVmRecord } from '../vm/vm-registry.mjs'
import { qualityIdentity, qualityOwnsPause, qualityScheduleVersion } from './vm-quality-identity.mjs'

// A synchronous compare-and-write: never drain requests, stop a kernel or touch Docker.
export function changeVmQualitySchedule(projectRoot, expected, schedulable) {
  const raw = getVm(projectRoot, expected.id)
  if (!raw) return null
  const vm = summarizeVm(raw, projectRoot)
  const identity = qualityIdentity(expected)
  if (qualityIdentity(vm) !== identity || qualityScheduleVersion(vm) !== qualityScheduleVersion(expected)) return null
  if (vm.status !== 'running' || !vm.has_token) return null
  if (schedulable ? !qualityOwnsPause(vm, identity) : vm.schedulable === false) return null
  const next = patchVmRecord(projectRoot, vm.id, {
    schedulable,
    schedule_disabled_reason: schedulable ? null : 'quality_degraded',
    schedule_quality_identity: schedulable ? null : identity,
    schedule_revision: crypto.randomUUID(),
    schedule_updated_at: new Date().toISOString(),
  })
  return next ? summarizeVm(next, projectRoot) : null
}
