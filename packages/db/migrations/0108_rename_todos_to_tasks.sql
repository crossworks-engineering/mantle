-- Retire the last two `todos`-named STORED identifiers, completing the app-level
-- Todos → Tasks rename at the storage layer. The node TYPE is already `task`;
-- this only renames organizational labels, so it is safe + reversible:
--   1. the ltree root label / branch node (path + slug + default title), and
--   2. the `todos` tool-group slug, plus every agent that grants it.
--
-- Nothing queries by these values — task list/get/count all filter by
-- `type='task'` — so this is a tidy-up, not a behavioural change. Idempotent:
-- once applied, the WHERE clauses match nothing on a re-run. Pairs with the code
-- change (TASKS_ROOT_LABEL = 'tasks', manifest tool-group slug 'tasks'); run this
-- migration BEFORE the app boot reconcile so the renamed group already exists.

-- 1a. The Tasks branch: re-path + re-slug (old brains created it as path/slug 'todos').
UPDATE "nodes" SET "slug" = 'tasks', "path" = 'tasks'::ltree
  WHERE "type" = 'branch' AND "path" = 'todos'::ltree;
--> statement-breakpoint
-- 1b. The branch's default title, only if the operator hasn't renamed it.
UPDATE "nodes" SET "title" = 'Tasks'
  WHERE "type" = 'branch' AND "slug" = 'tasks' AND "title" = 'Todos';
--> statement-breakpoint
-- 1c. Re-path every task node from the old flat root label to the new one.
UPDATE "nodes" SET "path" = 'tasks'::ltree
  WHERE "type" = 'task' AND "path" = 'todos'::ltree;
--> statement-breakpoint
-- 2a. Rename the tool group (its membership already points at task_* from the
--     app-level rename, and seedToolCapabilities will reaffirm it on reconcile).
UPDATE "tool_groups" SET "slug" = 'tasks' WHERE "slug" = 'todos';
--> statement-breakpoint
-- 2b. Repoint every agent (persona + operator-authored) that grants the group.
UPDATE "agents" SET "tool_group_slugs" = array_replace("tool_group_slugs", 'todos', 'tasks')
  WHERE 'todos' = ANY("tool_group_slugs");
