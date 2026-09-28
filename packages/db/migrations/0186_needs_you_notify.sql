-- "Needs you": one owner-level live event, `needs_you_changed`, whenever what
-- waits for an admin may have changed (Jason, 2026-09-28: an admin must never
-- be blind to work waiting for them). The payload is the brain's owner id,
-- the pending_changed convention; the client refetches the counts from
-- GET /api/team-admin/needs-you.
--
-- Raised by triggers, as runs_changed (0135) and tasks_changed (0148) are, so
-- no write path can forget it:
--   * a space item enters or leaves 'submitted' or 'taken' (submit, recall,
--     return, accept, take over, give back, a purge or delete);
--   * a login's role or deactivation changes (a deactivated author's shared
--     items become "left behind"; a deactivated admin's taken items go back
--     to the queue);
--   * a team-request task opens or closes (filed, done, reopened, deleted).
--
-- NOTIFY is transactional and identical payloads inside one transaction
-- collapse, so a bundle moving in one transaction wakes each listener once,
-- and a rolled-back write sends nothing. Listeners: the owner live stream
-- (server/web/lib/realtime.ts, admin sessions only) and the push worker
-- (admin devices only). Notify-only: these functions write nothing and no
-- listener starts LLM work (cost-safety).

-- SECURITY DEFINER: the space_items triggers run as the writer (the space
-- role for a member), which may not read spaces. The function reads the brain
-- id and notifies; nothing else. On a box there is one brain space (its id is
-- the anchor login's, the owner id every admin session carries).
CREATE OR REPLACE FUNCTION "public"."mantle_notify_needs_you"()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_notify('needs_you_changed', s.id::text)
     FROM "public"."spaces" s WHERE s.kind = 'brain';
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_notify_needs_you"() FROM PUBLIC;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "space_items_needs_you_ins_trg" ON "public"."space_items";
--> statement-breakpoint
CREATE TRIGGER "space_items_needs_you_ins_trg"
  AFTER INSERT ON "public"."space_items"
  FOR EACH ROW
  WHEN (new.review_state IN ('submitted', 'taken'))
  EXECUTE FUNCTION "public"."mantle_notify_needs_you"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "space_items_needs_you_upd_trg" ON "public"."space_items";
--> statement-breakpoint
-- A state change that touches the queue: into or out of 'submitted' or
-- 'taken', between the two (take over), a taken item changing hands, or an
-- Accept (a left-behind item is a draft or returned item until accepted).
-- Saves, comments and sharing changes never fire.
CREATE TRIGGER "space_items_needs_you_upd_trg"
  AFTER UPDATE OF "review_state", "taken_by" ON "public"."space_items"
  FOR EACH ROW
  WHEN (
    (old.review_state IS DISTINCT FROM new.review_state
      AND (old.review_state IN ('submitted', 'taken')
           OR new.review_state IN ('submitted', 'taken', 'accepted')))
    OR (new.review_state = 'taken' AND old.taken_by IS DISTINCT FROM new.taken_by)
  )
  EXECUTE FUNCTION "public"."mantle_notify_needs_you"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "space_items_needs_you_del_trg" ON "public"."space_items";
--> statement-breakpoint
-- A team-shared item may be a left-behind one (Discard deletes it).
CREATE TRIGGER "space_items_needs_you_del_trg"
  AFTER DELETE ON "public"."space_items"
  FOR EACH ROW
  WHEN (old.review_state IN ('submitted', 'taken') OR old.sharing = 'team')
  EXECUTE FUNCTION "public"."mantle_notify_needs_you"();
--> statement-breakpoint

-- Logins: a role change or a (re)activation moves items between the queue's
-- "submitted" and "left behind", or releases a gone admin's taken items.
DROP TRIGGER IF EXISTS "users_needs_you_upd_trg" ON "auth"."users";
--> statement-breakpoint
CREATE TRIGGER "users_needs_you_upd_trg"
  AFTER UPDATE OF "role", "disabled_at" ON "auth"."users"
  FOR EACH ROW
  WHEN (old.role IS DISTINCT FROM new.role
        OR (old.disabled_at IS NULL) IS DISTINCT FROM (new.disabled_at IS NULL))
  EXECUTE FUNCTION "public"."mantle_notify_needs_you"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "users_needs_you_del_trg" ON "auth"."users";
--> statement-breakpoint
CREATE TRIGGER "users_needs_you_del_trg"
  AFTER DELETE ON "auth"."users"
  FOR EACH ROW
  EXECUTE FUNCTION "public"."mantle_notify_needs_you"();
--> statement-breakpoint

-- Team requests: a `team-request` task in the brain that is not done. The
-- payload is the task's own owner (the brain). Fires only when "is an open
-- request" flips, so a board drag, an edit or the embedding backfill never
-- does.
CREATE OR REPLACE FUNCTION "public"."mantle_notify_needs_you_request"()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF tg_op = 'DELETE' THEN
    PERFORM pg_notify('needs_you_changed', old.owner_id::text);
  ELSE
    PERFORM pg_notify('needs_you_changed', new.owner_id::text);
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "public"."mantle_notify_needs_you_request"() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_needs_you_ins_trg" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_needs_you_ins_trg"
  AFTER INSERT ON "public"."nodes"
  FOR EACH ROW
  WHEN (new.type = 'task' AND 'team-request' = ANY(new.tags)
        AND coalesce(new.data->>'status', 'open') <> 'done')
  EXECUTE FUNCTION "public"."mantle_notify_needs_you_request"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_needs_you_upd_trg" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_needs_you_upd_trg"
  AFTER UPDATE ON "public"."nodes"
  FOR EACH ROW
  WHEN ((old.type = 'task' OR new.type = 'task')
        AND (old.type = 'task' AND 'team-request' = ANY(old.tags)
             AND coalesce(old.data->>'status', 'open') <> 'done')
            IS DISTINCT FROM
            (new.type = 'task' AND 'team-request' = ANY(new.tags)
             AND coalesce(new.data->>'status', 'open') <> 'done'))
  EXECUTE FUNCTION "public"."mantle_notify_needs_you_request"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "nodes_needs_you_del_trg" ON "public"."nodes";
--> statement-breakpoint
CREATE TRIGGER "nodes_needs_you_del_trg"
  AFTER DELETE ON "public"."nodes"
  FOR EACH ROW
  WHEN (old.type = 'task' AND 'team-request' = ANY(old.tags)
        AND coalesce(old.data->>'status', 'open') <> 'done')
  EXECUTE FUNCTION "public"."mantle_notify_needs_you_request"();
