-- Access matrix T20: an email attachment stays one when its email is deleted.
-- Mail sync now stamps data.emailAttachment on each attachment file it makes
-- (packages/email/src/sync.ts), and the attachment rule counts a stamped file
-- in an attachments folder whether or not its email is still above it
-- (packages/db/src/email-attachment.ts). This stamps the attachment files
-- synced before that, by the rule they were found by until now: a file in an
-- `attachments` folder with an email of the same owner just above it. A data
-- key only: no LLM work, no notify (no trigger reads this key).
--
-- Rollback: the previous release never reads the key; it can stay, or
-- `update nodes set data = data - 'emailAttachment' where type = 'file'`.
SET LOCAL lock_timeout = '30s';
--> statement-breakpoint

UPDATE "public"."nodes" AS f
   SET "data" = coalesce(f."data", '{}'::jsonb) || '{"emailAttachment": true}'::jsonb
 WHERE f."type" = 'file'
   AND nlevel(f."path") >= 2
   AND subpath(f."path", -1) = 'attachments'::ltree
   AND coalesce(f."data"->>'emailAttachment', '') <> 'true'
   AND EXISTS (
     SELECT 1 FROM "public"."nodes" mail_parent
      WHERE mail_parent."owner_id" = f."owner_id"
        AND mail_parent."type" = 'email'
        AND mail_parent."path" = subpath(f."path", 0, nlevel(f."path") - 1));
