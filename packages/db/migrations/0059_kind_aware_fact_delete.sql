-- Kind-aware fact + relation disposition when a node is deleted.
--
-- Decision (2026-05-30): extracted knowledge survives the deletion of its
-- source ONLY when it's a durable abstraction. Document-specific claims die
-- with the document.
--   • episodic  ("Jason said X on 2026-05-12")        → DELETE with the source
--   • factual   ("passport expires 2030-06-12")        → DELETE with the source
--   • semantic  ("Jason is a pastor")                  → KEEP (sourceless)
--   • preference("prefers terse replies")              → KEEP (sourceless)
--
-- Why a BEFORE DELETE trigger: `facts.source_node_id` is `ON DELETE SET NULL`,
-- so by the time an AFTER DELETE fires the FK has already nulled EVERY fact's
-- provenance — we'd no longer know which facts came from this node. BEFORE runs
-- while source_node_id still points at OLD.id. We hard-delete the episodic/
-- factual rows here; the FK then nulls the surviving semantic/preference rows'
-- provenance as the node row is removed (= the "kept, sourceless" state). Hard
-- delete (not valid_to retire) because the source node itself is hard-deleted —
-- preserving fact history for a vanished source would be incoherent.
--
-- Relation edges (entity↔entity, e.g. works_at) are durable knowledge and are
-- KEPT, but their `data.source_node_id` provenance now points at a gone row, so
-- we strip it — a kept relation should be cleanly sourceless, not cite a ghost.
-- (mentioned_in node-endpoint edges are reaped separately by
-- nodes_reap_entity_edges_trg, migration 0058.)
--
-- Pure SQL, no model call — not the runaway-cost class of trigger we avoid.
CREATE OR REPLACE FUNCTION public.reap_facts_for_node() RETURNS trigger AS $$
BEGIN
  DELETE FROM public.facts
   WHERE source_node_id = OLD.id
     AND kind IN ('episodic', 'factual');
  UPDATE public.entity_edges
     SET data = data - 'source_node_id'
   WHERE data->>'source_node_id' = OLD.id::text;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS nodes_reap_facts_trg ON public.nodes;
--> statement-breakpoint
CREATE TRIGGER nodes_reap_facts_trg
  BEFORE DELETE ON public.nodes
  FOR EACH ROW
  EXECUTE FUNCTION public.reap_facts_for_node();
