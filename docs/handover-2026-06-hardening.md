# Handover — security hardening, positioning, prod health (2026-06-12)

A continue-from-here brief after the v0.23.0 hardening pass, the README/site
positioning refresh, and a live prod health trace. Read top-to-bottom once; the
**Tracing the brain** section is the reusable part.

---

## Where things stand

- **v0.23.0 is live** — image on Docker Hub (`titanwest/mantle:v0.23.0` + `:latest`,
  multi-arch), GitHub Release cut, and **production rolled** (`jason.crossworks.network`,
  `/api/version` → `0.23.0`, gitSha `b3a50cd`). No DB migrations in this release.
- **`main` is one commit ahead of the v0.23.0 tag**: `6e8cf36`
  *fix(persona): responder delegates page authoring to Pages*. This is **applied
  live to the prod DB** (the `rich_writing` skill row) but is **not in a tagged
  release yet**. See *Open items #2*.
- **Marketing site** (`mantle-ai.tech`) updated to the new positioning and deployed.
- **Brain health: clean.** Full read-only trace done post-deploy — 0 container
  restarts, ~2.4 GB idle, 0 orphaned chunks, no trace errors in 24h, clean logs
  since the roll. One real fault found and fixed (below).

### Key commits this session (on `main`)
| sha | what |
|---|---|
| `22503be` | feat(security): harden API Console + agent autonomy |
| `7b78815` | docs(readme): reframe positioning around autonomy + safety |
| `b3a50cd` | release: v0.23.0  ← the tag points here |
| `6e8cf36` | fix(persona): responder delegates page authoring to Pages (post-tag) |

---

## What shipped in v0.23.0 (the hardening)

Driven by a multi-agent audit of the API Console / Toolsmith work and the
autonomous-execution core. All in commit `22503be`. Highlights:

- **Secret handling:** HTTP-tool *success* response bodies are now scrubbed
  (reflected secrets no longer reach the model); random per-dispatch secret
  tokens; base64 form scrubbed. `packages/tools/src/{dispatch,http-template}.ts`.
- **SSRF:** new `safeFetch` (drops secret headers on cross-origin redirects) and
  `guardedFetch`/`ssrf-guard` (blocks private/loopback/link-local/CGNAT/metadata,
  re-checked per hop). `web_fetch` now goes through the guard.
- **Toolsmith privilege:** tool-group/grant tools refuse non-http tools + self-grants;
  `api_tool_update` can't disarm shell tools or lower a confirm gate.
- **"Require approval for agent-built tools"** preference (**default OFF**) —
  Settings → Tools switch. ON ⇒ agent-authored tools start confirm-gated.
  `packages/content/src/profile-preferences.ts`, `tools-client.tsx`.
- **Prompt-injection containment:** retrieved content (facts/hits/relations/
  passages) is fenced as *data, never instructions* with a standing rule in the
  cached prefix; heartbeat fires carry the same boundary; `email_send` fails
  closed (no contacts ⇒ only your own addresses).
- **MCP:** mutating Toolsmith tools gated behind `MANTLE_MCP_TOOLSMITH_WRITE`
  (default on); zod bridge honours items/integer/nullable.
- Frontend correctness: stale-response guard, broadened localStorage scrub,
  JSON-tree paging, save-tool plaintext warning, MCP-bridge respawn-on-crash,
  file-serving XSS headers (`safe-download.ts`), tools-editor `timeoutMs` keep.

**Caveat carried over:** the changed paths are real-data-light in prod so far —
verify by *using* them (a couple of real chat turns; the page re-test below).

---

## The fault found + fixed (page save → note)

You asked Saskia to save a sermon summary "as a page"; it landed as a **Note**.
Root cause (traced in prod): the responder is intentionally granted **no page
tools** (P6 — authoring is the Pages specialist's job), but the `rich_writing`
skill still told her to use `page_create` herself. So the call hit an allowlist
refusal and she **silently fell back to a note**.

Fixed: rewrote the skill to **delegate page authoring to the Pages specialist**
and to refuse the silent note-downgrade. Applied to the live prod skill row +
committed (`6e8cf36`). **Your summary is safe** as the note *"Jase's Gospel
Foundation: A Summary from His Sermons"* — nothing lost.

---

## Open items / decisions

1. **Re-test page delegation.** Ask Saskia *"save that summary as a page"* (or
   anything → page). She should now delegate to Pages and it should appear in
   `/pages`. (Claude can re-trace the turn to confirm she delegated, not downgraded.)
2. **Optional `v0.23.1`** to realign image ↔ DB. The deployed v0.23.0 image still
   carries the *old* `rich_writing` text in its manifest; prod's DB has the fix.
   Default (gap-fill) seeds won't revert it — only a manual `overwrite` seed from
   the old image would. Low urgency; cut v0.23.1 when batching the next change.
3. **Deferred hardening** (not done, by choice — all localized):
   - Cross-agent grant confirmation (only *self*-grant is blocked today).
   - Fence `web_fetch`/search **tool results** (only auto-injected retrieval is
     fenced; the agent-pulled path isn't).
   - Opt-in hard egress-gate for heartbeats (force-confirm email/web on unattended
     fires) — would tie to a preference like the authored-tools switch.
   - Tier-3 latent footguns: `getApiKeyById` owner predicate, federation
     rate-limit + XFF-trust, session `tokenVersion`/`passwordChangedAt` revoke,
     `recordContactSent` `| string`, CSP on `/s`.

---

## Tracing the brain (the reusable part)

### In-app (browser)
- **`/debug`** — system vitals (Embedder + Tailnet pills, connections, versions).
- **`/debug/integrity`** — the corpus audit: half-indexed nodes, stale backups,
  dead-lettered jobs, with how-to-heal for each finding. Policy-aware (media/empty
  items that legitimately don't embed are classified OK, not drift).
- **Traces view** — the live "what did the brain just do" journey: every ingest,
  extraction, tool call, and model invocation as a trace with cost attribution.
  Filter to a `responder_turn` to see the exact tool sequence + errors of a chat.

### Docs
- [`observability.md`](./observability.md) / [`data-flow-tracing.md`](./data-flow-tracing.md)
  — the trace model + verifying ingest by hand.
- [`journey.md`](./journey.md) — every way content enters and what reacts.
- [`system-integrity.md`](./system-integrity.md) — the declarative manifest + the
  standing integrity checks behind `/debug/integrity`.
- [`memory.md`](./memory.md) §7 — as-built prompt assembly (where the new
  content-fence lives).
- [`update-prod.md`](./update-prod.md) — the prod update loop + its **Verify** block.

### Read-only health probe (SSH + psql)
The box: `ssh cwe@mcp.crossworks.network`, install dir `~/mantle`. A psql helper:

```bash
H=cwe@mcp.crossworks.network
PSQL(){ ssh $H "docker exec mantle_pg psql -U postgres -d postgres -tA -c \"$1\""; }
```

Runtime + resources:
```bash
ssh $H 'for c in $(docker ps -a --filter name=mantle_ --format "{{.Names}}"); do printf "%-26s restarts=%s status=%s\n" "$c" "$(docker inspect -f "{{.RestartCount}}" $c)" "$(docker inspect -f "{{.State.Status}}" $c)"; done'
ssh $H 'docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}" | grep mantle_'
```

Data integrity + traces + queues (the battery used this session):
```bash
PSQL "select type, count(*), count(*) filter (where embedding is null) no_embed from nodes group by type order by 2 desc"   # half-indexed
PSQL "select (select count(*) from content_chunks) chunks, (select count(*) from content_chunks c left join nodes n on n.id=c.node_id where n.id is null) orphaned"
PSQL "select status, count(*) from traces group by 1"                                  # success/skipped/error
PSQL "select kind, left(error,90), started_at from traces where error is not null and started_at > now()-interval '24 hours' order by started_at desc limit 10"
PSQL "select name, count(*), left(max(error),80) from trace_steps where (status='error' or error is not null) and started_at > now()-interval '24 hours' group by name order by 2 desc"
PSQL "select status, scanned, ingested, left(coalesce(error,''),50), started_at from sync_runs order by started_at desc limit 8"
PSQL "select state, count(*) from pgboss.job group by 1 order by 2 desc"               # job queue (failed = dead-letter)
PSQL "select state, count(*) from pg_stat_activity group by 1"                          # connections (watch it doesn't climb)
PSQL "select status, tool_slug, created_at from pending_tool_calls order by created_at desc limit 10"   # stuck approvals
```

Trace one conversation end-to-end (swap the trace id):
```bash
PSQL "select id, status, to_char(started_at,'HH24:MI') t, step_count, left(coalesce(error,''),60) from traces where kind='responder_turn' order by started_at desc limit 8"
PSQL "select ordinal, name, kind, status from trace_steps where trace_id='<TRACE_ID>' order by ordinal"
PSQL "select error from trace_steps where trace_id='<TRACE_ID>' and ordinal=<N>"        # a failed step's error
```
> Note: `trace_step_kind` enum is `{db_read,db_write,llm_call,embed,http,notify,compute,send}`
> — tool calls show as `compute`/`db_write` with the tool name in `name`
> (e.g. `tool: page_create`). `input`/`output`/`meta` are jsonb (cast carefully).

---

## Deploy / rollback quick reference

- **App release:** `pnpm version:bump <minor|patch>` → `git commit -am "release: vX"`
  → `git tag vX && git push origin main vX`. The tag triggers CI (multi-arch image
  + GitHub Release). **CI does not run tests** — `vitest run` + `pnpm -r typecheck`
  are the local gate.
- **Prod update (registry-pull, now viable post multi-arch CI):**
  ```bash
  ssh $H 'cd ~/mantle && bash scripts/db-dump.sh'        # ALWAYS back up first
  ssh $H 'cd ~/mantle && docker compose pull && docker compose up -d --wait'
  ```
  Leave `worker_telegram` RUNNING (prod owns `saskianewbot`). Build-on-VPS is the
  documented alternative; see [`update-prod.md`](./update-prod.md).
- **Site:** `cd ~/Projects/mantle-site && ./scripts/deploy.sh` (build + rsync + caddy reload).
- **Rollback:** pre-v0.23.0 prod dump at `~/mantle/backups/mantle-20260612-205834.dump`
  on the box. Code: re-pull the prior tag. Schema is forward-only (this release
  had none, so rollback is just re-pulling the old image).

## Local artifacts (this machine)
- `/tmp/rich_writing.prod-backup` — the **old** `rich_writing` skill text (pre-fix),
  in case the persona delegation change needs reverting.
