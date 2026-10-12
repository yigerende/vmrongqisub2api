import crypto from 'node:crypto'

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

export const qualityScheduleVersion = (vm) => vm.schedule_revision || vm.schedule_updated_at || null

export function qualityOwnsPause(vm, identity) {
  return (
    vm.schedulable === false &&
    vm.schedule_disabled_reason === 'quality_degraded' &&
    vm.schedule_quality_identity === identity
  )
}
