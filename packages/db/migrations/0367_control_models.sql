-- Control Center phase 4: the first fleet write, an agent's model
-- (docs/control-center.md, "Set an agent's model on the fleet").
--
-- On the CC only (control_boxes has rows there alone):
--  - model_job: agent models waiting for the control service: up to 20
--    { slug, model } changes, who asked and when. No secret. The control
--    service sends them at the box's next run (at once: asking sets
--    run_requested_at) and clears the job whatever the box answers; a job
--    older than an hour is dropped unsent.
--  - model_result: what the box answered to the last model job, per
--    change: ok and the model it had, or one reason code.
--
-- Written only through the CC store's one gateway, at the full-route spot
-- control-center, as every other column of the table. Re-runnable.
ALTER TABLE "public"."control_boxes" ADD COLUMN IF NOT EXISTS "model_job" jsonb;
--> statement-breakpoint
ALTER TABLE "public"."control_boxes" ADD COLUMN IF NOT EXISTS "model_result" jsonb;
