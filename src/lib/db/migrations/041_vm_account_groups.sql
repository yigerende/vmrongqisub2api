-- Keep existing pool IDs/key bindings; accounts may now join several groups.
DROP INDEX IF EXISTS idx_vm_pool_members_vm;
CREATE INDEX idx_vm_pool_members_vm ON vm_pool_members(vm_id);
