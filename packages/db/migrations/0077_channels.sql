-- Comms channels (docs/comms-channels.md §4/§5): the generic transport binding.
--
-- A `channels` row attaches a transport (Telegram, later Discord/Slack) to ANY
-- agent — transport stops being a function of `agents.role`. Additive: the
-- Telegram-specific state/data tables stay; `telegram_accounts` gains a 1:1
-- `channel_id` link (nullable for now, backfilled by the agent-boot re-seal
-- pass — tokens must be decrypted + re-encrypted in app code, AAD = channels.id,
-- so the backfill can't be pure SQL). Cut-over + the responder_agent_id drop
-- come in later migrations.

CREATE TABLE "channels" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "owner_id"        uuid NOT NULL,
  "agent_id"        uuid NOT NULL,
  "type"            "public"."channel_type" NOT NULL,
  "display_name"    text NOT NULL,
  "credentials_enc" bytea NOT NULL,
  "config"          jsonb DEFAULT '{}'::jsonb NOT NULL,
  "enabled"         boolean DEFAULT true NOT NULL,
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"      timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "channels_agent_id_agents_id_fk" FOREIGN KEY ("agent_id")
    REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "channels_owner_idx" ON "channels" USING btree ("owner_id");
--> statement-breakpoint
CREATE INDEX "channels_agent_idx" ON "channels" USING btree ("agent_id");
--> statement-breakpoint
-- An agent carries at most one channel of a given transport type.
CREATE UNIQUE INDEX "channels_agent_type_uq" ON "channels" USING btree ("agent_id", "type");
--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD COLUMN "channel_id" uuid;
--> statement-breakpoint
ALTER TABLE "telegram_accounts" ADD CONSTRAINT "telegram_accounts_channel_id_channels_id_fk"
  FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "telegram_accounts_channel_idx" ON "telegram_accounts" USING btree ("channel_id");
