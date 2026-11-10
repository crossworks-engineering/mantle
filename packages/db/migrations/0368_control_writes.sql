-- Control Center phase 4, the rest of the first fleet writes: a model pool
-- entry, the update notice and a worker group (docs/control-center.md,
-- "Fleet writes"). They join the agent models of 0367 in ONE job per box,
-- so the two columns take the job's name:
--  - write_job: the changes waiting for the control service, in the order
--    asked, each { kind, ...its fields, by, at }. No secret. A newer request
--    adds to the end (at most 40 wait per box); the control service sends
--    each change once at the box's next run (at once: asking sets
--    run_requested_at) and takes the sent ones off the front; a change
--    older than an hour is dropped unsent.
--  - write_result: the box's answers, the last 40 kept, newest last, each
--    the change with ok, was, reason and done.
--
-- A job or result 0367 left (agent models only) takes the new shape: its
-- changes become kind agentModel with the job's by and at.
--
-- Written only through the CC store's one gateway, at the full-route spot
-- control-center, as every other column of the table. Re-runnable.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'control_boxes' AND column_name = 'model_job') THEN
    ALTER TABLE "public"."control_boxes" RENAME COLUMN "model_job" TO "write_job";
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'control_boxes' AND column_name = 'model_result') THEN
    ALTER TABLE "public"."control_boxes" RENAME COLUMN "model_result" TO "write_result";
  END IF;
END $$;
--> statement-breakpoint
UPDATE "public"."control_boxes" SET "write_job" = jsonb_build_object('changes',
  (SELECT coalesce(jsonb_agg(c || jsonb_build_object('kind', 'agentModel',
      'by', "write_job"->>'by', 'at', "write_job"->>'at') ORDER BY i), '[]'::jsonb)
    FROM jsonb_array_elements("write_job"->'changes') WITH ORDINALITY t(c, i)))
  WHERE "write_job"->>'at' IS NOT NULL;
--> statement-breakpoint
UPDATE "public"."control_boxes" SET "write_result" = jsonb_build_object('results',
  (SELECT coalesce(jsonb_agg(r || jsonb_build_object('kind', 'agentModel',
      'by', "write_result"->>'by', 'at', "write_result"->>'at', 'done', "write_result"->>'at') ORDER BY i), '[]'::jsonb)
    FROM jsonb_array_elements("write_result"->'results') WITH ORDINALITY t(r, i)))
  WHERE "write_result"->>'at' IS NOT NULL;
