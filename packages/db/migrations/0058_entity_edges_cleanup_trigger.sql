-- Reap entity_edges when the node they point at is deleted.
--
-- entity_edges has NO foreign key on source_id/target_id — the schema is
-- polymorphic (source_kind/target_kind ∈ entity|fact|node) so integrity is
-- "application-level" per the table comment. The practical fallout: deleting a
-- node leaves every edge that named it as a literal endpoint — chiefly the
-- `mentioned_in` edges (entity → node, target_kind='node') — dangling forever,
-- pointing at a row that's gone. The knowledge graph slowly fills with edges to
-- deleted content (a manual scripts/dedupe-edges.ts hints this was known).
--
-- This AFTER DELETE trigger reaps those edges. It fires for EVERY node delete —
-- UI, MCP, direct SQL, and cascade-deleted child pages (parent_id ON DELETE
-- CASCADE) — which an application-layer helper would miss, and it can do so
-- precisely because there's no FK to lean on.
--
-- Cost note: this is pure SQL (two indexed deletes via entity_edges_source_idx /
-- _target_idx) — NO model call — so it is NOT the runaway-LLM-cost class of
-- trigger we otherwise avoid on the nodes table. Safe to fire per-row.
--
-- Deliberately NOT cleaned here: relation-edge provenance (data->>'source_node_id'
-- of entity↔entity edges) and facts (facts.source_node_id is ON DELETE SET NULL).
-- Those are the "is extracted knowledge durable beyond its source?" decision and
-- are left untouched pending that call. We only reap edges where the deleted node
-- was itself an endpoint — those are unambiguously dead.
CREATE OR REPLACE FUNCTION public.reap_entity_edges_for_node() RETURNS trigger AS $$
BEGIN
  DELETE FROM public.entity_edges
   WHERE (source_kind = 'node' AND source_id = OLD.id)
      OR (target_kind = 'node' AND target_id = OLD.id);
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS nodes_reap_entity_edges_trg ON public.nodes;
--> statement-breakpoint
CREATE TRIGGER nodes_reap_entity_edges_trg
  AFTER DELETE ON public.nodes
  FOR EACH ROW
  EXECUTE FUNCTION public.reap_entity_edges_for_node();
