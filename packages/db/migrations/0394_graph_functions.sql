-- The knowledge graph's walk as two functions (docs/knowledge-graph.md,
-- "6.1 The walk is two database functions (migration 0394)"). Before this,
-- graph_path sent a recursive CTE as text that built every simple path and
-- then kept the shortest one per entity: on a client brain (3,526
-- entities, 4,636 entity-to-entity edges, one entity with 816 links) three
-- steps from the busiest entity made 898,858 paths for 1,389 entities
-- (2.1 s), and four steps did not end in 8 s. These walk level by level
-- and visit each entity once, so the cost grows with the entities and
-- edges touched, not with the paths.
--
-- 1. mantle_graph_walk(owner, start, max_depth, relations, directed,
--    current_only, limit, target): every entity within max_depth steps of
--    start, each once, with the shortest chain of hops to it (path_ids:
--    start first, the entity last; relations: the verb of each hop) and
--    its depth. Breadth first: one set query per level finds the next
--    level from the edges of the current one, leaving out every entity
--    already visited; a parent index per entity rebuilds the path at the
--    end. max_depth is clamped to 1..6 (default 3), limit to 1..200
--    (default 50). relations null or empty: every verb. directed false
--    (the default): an edge is walked both ways. current_only true (the
--    default): an edge whose valid_to is set is not walked. Only edges
--    with source_kind and target_kind 'entity', and only of the owner.
--    The rows come nearest first, so the walk stops once a level fills
--    the limit. target, when given: the walk stops at the level that
--    reaches it and answers that one row (or none within max_depth).
--
--    The tie-break (two shortest paths to one entity): the path that is
--    first when its hops are compared from the start, each hop by its
--    relation verb, then by the entity's id. The rows come in that order
--    too (by depth, then by path). Each level is ordered by (parent's
--    place, relation, id), so a parent's place is its path's order, and an
--    entity keeps the first parent and the first verb that reach it.
--
-- 2. mantle_graph_path(owner, from, to, max_depth, relations, directed,
--    current_only): the shortest path between two entities, by the same
--    rule: the walk with to as its target. No row when they do not meet
--    within max_depth (or to is null, or to is from).
--
-- Both run as their caller (SECURITY INVOKER): the caller's grants and row
-- rules on entity_edges apply as they do to the text the walk was before.
-- STABLE, they read only, with no temporary table, so they run inside a
-- READ ONLY transaction (graphPath reads in one). Open to PUBLIC, as the
-- other invoker reads (mantle_may_manage_in): a function that runs as its
-- caller gives no right the caller does not hold.
--
-- No table, column, index or trigger. No LLM work.
-- Rollback: packages/db/rollback/0394_graph_functions.revert.sql.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_graph_walk"(
  p_owner uuid,
  p_from uuid,
  p_max_depth integer DEFAULT 3,
  p_relations text[] DEFAULT NULL,
  p_directed boolean DEFAULT false,
  p_current_only boolean DEFAULT true,
  p_limit integer DEFAULT 50,
  p_target uuid DEFAULT NULL)
  RETURNS TABLE ("entity_id" uuid, "depth" integer, "path_ids" uuid[], "relations" text[])
  LANGUAGE plpgsql STABLE SECURITY INVOKER
  SET search_path = "public", pg_temp AS $$
#variable_conflict use_column
DECLARE
  max_d integer := least(greatest(coalesce(p_max_depth, 3), 1), 6);
  lim integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  rels text[] := CASE WHEN cardinality(p_relations) > 0 THEN p_relations END;
  cur_only boolean := coalesce(p_current_only, true);
  both_ways boolean := NOT coalesce(p_directed, false);
  -- Every visited entity in visit order (index 1: the start), with its
  -- parent's index, the verb into it and its depth.
  v_ids uuid[] := ARRAY[p_from];
  v_par integer[] := ARRAY[0];
  v_rel text[] := ARRAY[NULL::text];
  v_dep integer[] := ARRAY[0];
  lo integer := 1;
  hi integer := 1;
  d integer := 0;
  n_ids uuid[];
  n_par integer[];
  n_rel text[];
  n integer;
  first_k integer := 2;
  last_k integer;
  hit integer;
  k integer;
  j integer;
  p_ids uuid[];
  p_rels text[];
BEGIN
  IF p_owner IS NULL OR p_from IS NULL THEN
    RETURN;
  END IF;
  WHILE d < max_d AND hi >= lo LOOP
    d := d + 1;
    -- The next level: every entity one edge from the current level
    -- (v_ids[lo:hi]) and not yet visited, each once, with the first parent
    -- and verb that reach it.
    SELECT coalesce(array_agg(c.other ORDER BY c.par, c.relation, c.other), '{}'),
           coalesce(array_agg(c.par ORDER BY c.par, c.relation, c.other), '{}'),
           coalesce(array_agg(c.relation ORDER BY c.par, c.relation, c.other), '{}')
      INTO n_ids, n_par, n_rel
      FROM (
        SELECT DISTINCT ON (x.other) x.other, x.par, x.relation
          FROM (
            SELECT e.target_id AS other, lo - 1 + f.ord::integer AS par, e.relation
              FROM unnest(v_ids[lo:hi]) WITH ORDINALITY AS f(id, ord)
              JOIN "public"."entity_edges" e ON e.source_id = f.id
             WHERE e.owner_id = p_owner
               AND e.source_kind = 'entity' AND e.target_kind = 'entity'
               AND (rels IS NULL OR e.relation = ANY (rels))
               AND (NOT cur_only OR e.valid_to IS NULL)
            UNION ALL
            SELECT e.source_id, lo - 1 + f.ord::integer, e.relation
              FROM unnest(v_ids[lo:hi]) WITH ORDINALITY AS f(id, ord)
              JOIN "public"."entity_edges" e ON e.target_id = f.id
             WHERE both_ways
               AND e.owner_id = p_owner
               AND e.source_kind = 'entity' AND e.target_kind = 'entity'
               AND (rels IS NULL OR e.relation = ANY (rels))
               AND (NOT cur_only OR e.valid_to IS NULL)
          ) x
         -- A hashed subplan: the visited set is hashed once per level.
         WHERE x.other NOT IN (SELECT unnest(v_ids))
         ORDER BY x.other, x.par, x.relation
      ) c;
    n := cardinality(n_ids);
    EXIT WHEN n = 0;
    v_ids := v_ids || n_ids;
    v_par := v_par || n_par;
    v_rel := v_rel || n_rel;
    v_dep := v_dep || array_fill(d, ARRAY[n]);
    lo := hi + 1;
    hi := hi + n;
    IF p_target IS NOT NULL THEN
      hit := array_position(n_ids, p_target);
      IF hit IS NOT NULL THEN
        first_k := lo - 1 + hit;
        last_k := first_k;
        EXIT;
      END IF;
    ELSIF hi - 1 >= lim THEN
      EXIT;
    END IF;
  END LOOP;
  IF p_target IS NOT NULL THEN
    IF last_k IS NULL THEN
      RETURN;
    END IF;
  ELSE
    last_k := least(hi, lim + 1);
  END IF;
  -- Each row's path, rebuilt from the parent indexes.
  FOR k IN first_k .. last_k LOOP
    p_ids := ARRAY[]::uuid[];
    p_rels := ARRAY[]::text[];
    j := k;
    WHILE j > 1 LOOP
      p_ids := array_prepend(v_ids[j], p_ids);
      p_rels := array_prepend(v_rel[j], p_rels);
      j := v_par[j];
    END LOOP;
    entity_id := v_ids[k];
    depth := v_dep[k];
    path_ids := array_prepend(p_from, p_ids);
    relations := p_rels;
    RETURN NEXT;
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."mantle_graph_path"(
  p_owner uuid,
  p_from uuid,
  p_to uuid,
  p_max_depth integer DEFAULT 3,
  p_relations text[] DEFAULT NULL,
  p_directed boolean DEFAULT false,
  p_current_only boolean DEFAULT true)
  RETURNS TABLE ("entity_id" uuid, "depth" integer, "path_ids" uuid[], "relations" text[])
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = "public", pg_temp AS $$
  SELECT w."entity_id", w."depth", w."path_ids", w."relations"
    FROM "public"."mantle_graph_walk"(p_owner, p_from, p_max_depth, p_relations,
                                      p_directed, p_current_only, 1, p_to) w
   WHERE p_to IS NOT NULL
$$;
