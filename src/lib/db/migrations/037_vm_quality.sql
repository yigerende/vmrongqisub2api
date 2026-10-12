CREATE TABLE vm_quality_state (
  vm_id TEXT PRIMARY KEY,
  identity TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  question_cursor INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE vm_quality_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vm_id TEXT NOT NULL REFERENCES vm_quality_state(vm_id) ON DELETE CASCADE,
  payload TEXT NOT NULL
);
CREATE INDEX vm_quality_history_vm ON vm_quality_history(vm_id, id DESC);
