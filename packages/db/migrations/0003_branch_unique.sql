-- Enforce one branch node per (owner, path) and clean up the duplicates
-- the original `ensureBranchPath` left behind. The bug: it called
-- `onConflictDoNothing()` with no target, which is a no-op without a
-- matching unique constraint, so every email ingest minted fresh
-- top-level branches.

-- 1. Dedupe: keep the oldest branch row per (owner_id, path), drop the rest.
--    Children don't cascade because branch nodes never have parent_id set
--    (the tree hierarchy is encoded in the `path` ltree, not the FK).
delete from "public"."nodes" n
using (
  select id,
         row_number() over (
           partition by owner_id, path
           order by created_at asc, id asc
         ) as rn
  from "public"."nodes"
  where type = 'branch'
) ranked
where n.id = ranked.id and ranked.rn > 1;

-- 2. Lock in the invariant. Partial index — only branches need to be
--    unique per path; emails and files legitimately share paths.
create unique index if not exists "nodes_branch_owner_path_uq"
  on "public"."nodes" ("owner_id", "path")
  where "type" = 'branch';
