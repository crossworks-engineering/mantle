-- 0063: per-route base URL + tailnet flag for chat routes (agents + ai_workers).
--
-- Completes the "point a chat route at a self-hosted box" surface. The `local`
-- chat adapter (commit 4cbbeeb) honours a per-call base URL and a "via tailnet"
-- flag, but until now nothing carried them from the row into the call — local
-- chat could only use the global MANTLE_LOCAL_CHAT_URL env, and the Tailscale
-- proxy could not be engaged per route. These columns close that gap.
--
-- base_url      — override the provider's default host for THIS route (e.g.
--                 http://gpu-box:11434/v1). Blank = provider default. Mirrors
--                 the embedding_config per-route base_url.
-- via_tailnet   — when true, dispatch this route's HTTP through the bundled
--                 Tailscale forward-proxy (tailnetFetch) so a base_url pointing
--                 at a MagicDNS name reaches a NAT'd box. Inert unless the
--                 `tailnet` compose profile is up (proxy unset → direct fetch).
--
-- Added for BOTH the primary and backup routes (migration 0062), so a
-- local-via-tailnet primary can pair with a cloud-direct backup, or the reverse.
-- Purely additive + defaulted: existing rows are unchanged (base_url NULL →
-- provider default; via_tailnet false → direct fetch, identical to before).

ALTER TABLE "agents" ADD COLUMN "base_url" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "via_tailnet" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "backup_base_url" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "backup_via_tailnet" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_workers" ADD COLUMN "base_url" text;
--> statement-breakpoint
ALTER TABLE "ai_workers" ADD COLUMN "via_tailnet" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "ai_workers" ADD COLUMN "backup_base_url" text;
--> statement-breakpoint
ALTER TABLE "ai_workers" ADD COLUMN "backup_via_tailnet" boolean DEFAULT false NOT NULL;
