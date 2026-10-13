-- Cover retention reads with small index entries, instead of scanning GBs of
-- record_json on every cleanup. Built once at upgrade, before accepting traffic.
CREATE INDEX IF NOT EXISTS idx_reqdbg_retention
  ON request_log_debug(ts, request_id, length(CAST(record_json AS BLOB)));
