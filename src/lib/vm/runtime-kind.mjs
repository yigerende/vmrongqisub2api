export const RUNTIME_DOCKER = 'docker'
export const RUNTIME_KVM = 'kvm'

/** Space assignments always own their guest kernel, in either runtime. */
export const managedCodex = (vm) => ['docker_per_slot', 'kvm_per_slot'].includes(vm?.execution_mode)

const KVM_ALIASES = new Set(['kvm', 'qemu', 'libvirt'])

/** Slot hypervisor kind. Default docker so existing vm.json keeps working. */
export function runtimeKind(vm = {}) {
  const raw = String(vm?.runtime?.type || vm?.runtime_type || '')
    .trim()
    .toLowerCase()
  if (KVM_ALIASES.has(raw)) return RUNTIME_KVM
  return RUNTIME_DOCKER
}

export function isKvmRuntime(vm) {
  return runtimeKind(vm) === RUNTIME_KVM
}
