-- Control Center phase 2, item 1: the fleet API-key update
-- (docs/control-center.md, "Set a provider key on the fleet").
--
-- On the CC only (control_boxes has rows there alone):
--  - key_job: a provider key waiting for the control service: the service's
--    name, the value sealed with the CC's master key (AAD: the box id), who
--    asked and when. The control service sends it at the box's next run (at
--    once: asking sets run_requested_at) and clears it whatever the box
--    answers, and deletes it unsent once it is an hour old: the CC holds a
--    sealed key until it is sent (seconds), an hour at most.
--  - key_result: what the box answered to the last key call: the service,
--    ok or one reason code, who asked and when. Never a value.
--
-- Written only through the CC store's one gateway, at the full-route spot
-- control-center, as every other column of the table. Re-runnable.
ALTER TABLE "public"."control_boxes" ADD COLUMN IF NOT EXISTS "key_job" jsonb;
--> statement-breakpoint
ALTER TABLE "public"."control_boxes" ADD COLUMN IF NOT EXISTS "key_result" jsonb;
