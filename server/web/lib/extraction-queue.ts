/**
 * The extractor's queue at a glance, as counts: what runs, waits and
 * retries now, what finished in the last ten minutes, and what is
 * dead-lettered (the integrity audit's `extract_dead_letter` rows: a node
 * whose extraction used up its retries). Shared by GET
 * /api/embedding/extraction and box_status (box-status.ts). Numbers only.
 *
 * The one read of pg-boss's job table is `extractionQueueCounts` in
 * @mantle/db (packages/db/src/provider-alerts.ts), beside the busy rule
 * `pipeline_run` asks (EXTRACT_BUSY_JOBS, the same number as
 * scripts/box-maintain.sh). This file does not write the SQL again.
 */
export { extractionQueueCounts, type ExtractionQueueCounts } from '@mantle/db';
