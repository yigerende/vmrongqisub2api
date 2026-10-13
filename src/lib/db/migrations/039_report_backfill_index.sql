-- Completed/priced rows need not be scanned on every billing page read.
CREATE INDEX IF NOT EXISTS idx_usage_unpriced
ON usage_logs(id) WHERE total_cost IS NULL AND pricing_model IS NULL;
