ALTER TABLE vm_quality_state ADD COLUMN failure_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vm_quality_state ADD COLUMN recovery_streak INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vm_quality_state ADD COLUMN schedule_version TEXT;
