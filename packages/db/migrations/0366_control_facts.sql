-- Control Center phase 3: the fleet matrix (docs/control-center.md, "The
-- fleet matrix").
--
-- On the CC only (control_boxes has rows there alone):
--  - facts: the box's last good answer to the signed `facts` call: box
--    status numbers, the sign-in mode, each agent's and worker's provider
--    and model, two counts and the last backup. Never a prompt, a key or
--    user data.
--  - facts_reason: null after a good read, else its reason code; the last
--    good facts stay, with their own time.
--
-- Written only through the CC store's one gateway, at the full-route spot
-- control-center, as every other column of the table. Re-runnable.
ALTER TABLE "public"."control_boxes" ADD COLUMN IF NOT EXISTS "facts" jsonb;
--> statement-breakpoint
ALTER TABLE "public"."control_boxes" ADD COLUMN IF NOT EXISTS "facts_reason" text;
