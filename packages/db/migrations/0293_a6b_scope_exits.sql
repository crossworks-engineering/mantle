-- Arch A6b (plan v2 page fcc4aee4, the system-pool exits toward 40): where
-- a library left the caller's scope for the system pool to read one answer
-- the scope does not hold, a definer here returns exactly that answer, and
-- the library asks it in the scope.
--
-- Every definer below: a fixed search_path (pg_temp last), no right for
-- PUBLIC, EXECUTE for the workspace role (and so the write role, which
-- mirrors its function rights: applyViewerGrants, and the runtime role,
-- whose allowlist holds what a viewer role may run) and the public demo's
-- SELECT-only reader when it exists. The caller is read from the scope's
-- settings, never from an argument; with no scope set (the system pool) a
-- definer answers as the system pool read.
--
-- 1. mantle_kind_root_id(owner, label): the id of a kind's root folder (the
--    top-level branch at `label`: the files root), whatever the scope
--    holds. Structure, not content: the root is homed in Admin, and a
--    reader that does not see it must not make it again (W6b). Only the id:
--    the system pool read the whole row ('kind-root'), and every caller
--    asked only whether it is there. In a scope only the brain's own.
--
-- No table, no row, no trigger and no LLM work changes. Re-runnable:
-- CREATE OR REPLACE only.

CREATE OR REPLACE FUNCTION "public"."mantle_kind_root_id"(owner uuid, label text)
  RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = "public", pg_temp AS $$
  SELECT n."id" FROM "public"."nodes" n
   WHERE n."owner_id" = owner AND n."type" = 'branch' AND n."path"::text = label
     AND nlevel(n."path") = 1
     AND (NOT "public"."mantle_scope_active"() OR owner = "public"."mantle_brain_id"())
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."mantle_kind_root_id"(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."mantle_kind_root_id"(uuid, text) TO "mantle_view_user";
--> statement-breakpoint

-- The public demo's SELECT-only reader serves owner reads (as 0285, 0286, 0291).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    GRANT EXECUTE ON FUNCTION "public"."mantle_kind_root_id"(uuid, text) TO demo_reader;
  END IF;
END
$$;
