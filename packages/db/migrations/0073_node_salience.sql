-- Node-level retrieval salience: a 0..1 weight (1 = full personal value) that
-- lets the brain down-weight bulk/marketing email so newsletters can't crowd
-- out real content. Detection already exists (emails.delivery_kind, computed at
-- sync from headers — see @mantle/email#classifyDelivery); this surfaces it to
-- the node layer that retrieval actually ranks. A down-weight, never a filter.
-- See docs/recall-eval.md.

ALTER TABLE nodes ADD COLUMN salience real NOT NULL DEFAULT 1.0;

-- Backfill existing email nodes from their message's delivery_kind. Keep this
-- map in sync with salienceForDeliveryKind() in packages/email (the ingest
-- write path uses the TS version going forward). Non-email nodes keep 1.0.
-- direct/unknown = full (fail open); automated (receipts, OTPs) only mildly
-- demoted since you do search those; list medium; marketing strongly demoted.
UPDATE nodes n
SET salience = CASE e.delivery_kind
    WHEN 'marketing' THEN 0.25
    WHEN 'list'      THEN 0.5
    WHEN 'automated' THEN 0.75
    ELSE 1.0  -- direct, unknown
  END
FROM emails e
WHERE e.node_id = n.id
  AND e.delivery_kind <> 'direct';

-- No index: salience is read alongside the per-row vector scan that retrieval
-- already does (ORDER BY embedding <=> q), not filtered on directly.
