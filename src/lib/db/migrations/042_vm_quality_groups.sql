-- Keep the original membership until recovery, including an empty group list.
ALTER TABLE vm_quality_state ADD COLUMN original_group_ids TEXT;
ALTER TABLE vm_quality_state ADD COLUMN switched_group_ids TEXT;
ALTER TABLE vm_quality_state ADD COLUMN group_action_error TEXT;
ALTER TABLE vm_quality_state ADD COLUMN membership_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vm_quality_state ADD COLUMN group_version INTEGER NOT NULL DEFAULT 0;

-- Detect operator membership edits (even remove/re-add) while a probe is in flight.
-- Quality writes acknowledge the resulting version in the same transaction.
CREATE TRIGGER vm_quality_membership_insert AFTER INSERT ON vm_pool_members BEGIN
  UPDATE vm_quality_state SET membership_version = membership_version + 1 WHERE vm_id = NEW.vm_id;
END;
CREATE TRIGGER vm_quality_membership_delete AFTER DELETE ON vm_pool_members BEGIN
  UPDATE vm_quality_state SET membership_version = membership_version + 1 WHERE vm_id = OLD.vm_id;
END;
CREATE TRIGGER vm_quality_membership_update AFTER UPDATE OF pool_id, vm_id ON vm_pool_members BEGIN
  UPDATE vm_quality_state SET membership_version = membership_version + 1 WHERE vm_id IN (OLD.vm_id, NEW.vm_id);
END;
