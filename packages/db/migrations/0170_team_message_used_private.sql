-- Member logins, audit S3: admins never see a member's private items. A team
-- reply written by a turn that read the member's personal items (the my-space
-- tools), or that followed such a reply in the thread, can quote them. It is
-- marked here; the admin readers of member chats show a placeholder instead of
-- its text. The member reads their own thread in full.
ALTER TABLE "public"."team_messages"
  ADD COLUMN IF NOT EXISTS "used_private" boolean DEFAULT false NOT NULL;
