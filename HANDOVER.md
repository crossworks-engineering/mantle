# Session handover — brain audit + fixes + backups + repo cutover (2026-06-10/11)

> **TL;DR.** A full critical audit of the brain (write path, read path,
> conversation memory, cross-cutting) found ~35 issues; every Critical/High
> except one is now **fixed and deployed to prod** (v0.20.45 → v0.20.50).
> Backups became a product feature at **/settings/backups** (the
> operator-specific scripts left the repo). The one remaining Critical — the
> **brain trust model** — is written up as an implementation-ready brief in
> [`docs/handover-trust-model.md`](./docs/handover-trust-model.md). That's
> the next piece of work.

## What shipped this session (all on `main`, all deployed)

| Version | What |
|---|---|
| v0.20.45 | **Prompt-cache fix** — per-turn text (millisecond time line, query-ranked facts, heartbeat block) moved OUT of cache breakpoint 1 via `buildChatMessages`'s new `volatileContext`; cross-turn cache reads were structurally 0% before. Regression-tested in `messages.test.ts`. Third-pass addendum in [`docs/audit-chat-cost-2026-06-07.md`](./docs/audit-chat-cost-2026-06-07.md). |
| v0.20.46 | **Digest embeddings + summarizer integrity** — digests embedded at insert (`find_window` was structurally blind: 27/27 dumps had no vector on BOTH envs; backfilled via `backfill:digest-embeddings`); summarizer got a per-agent in-flight guard + single-transaction `SELECT … FOR UPDATE` batch claim (the 2s debounce never covered a 10-60s LLM call). |
| v0.20.48 | **Extract-queue + extractor retry safety** — queue `policy:'short'` (singletonKey dedup was a verified NO-OP on `standard`), per-node in-process serialization, `extract_completed_at` completion-marker skip guard, `xmin` edit-during-extract guard, transactional chunk/edge rebuilds, embed failures throw, DLQ re-driven on boot + `/debug/integrity` check. Legacy nodes stamped on both DBs (zero re-extract spend). |
| v0.20.49 | **Built-in scheduled backups** — `/settings/backups` (frequency, hour in user tz, retention, folder), engine in `packages/content/src/backup.ts`, scheduler tick in the events worker, `postgresql-client-17` in the image, compose mount `${MANTLE_DATA_DIR}/backups`. Operator-specific backup scripts **removed from the repo** (this is OSS; offsite sync is the operator's own tool pointed at the folder). |
| v0.20.50 | **Stale-backup integrity check** — `backup_stale` in `/debug/integrity` (enabled but last success > 2× interval / never), `BackupStatus.lastSuccessAt` preserved across failures. |
| v0.20.51–55 | **Docs overhaul + handovers** — trust-model brief, marketing README + getting-started split, website handover, embodied-companion (robot/MCP) handover, doc-vs-code sync. |
| v0.20.56 | **/debug/context** (parallel session) — per-turn retrieval snapshots: what was pulled, at what distance, what the cutoffs rejected. |
| v0.20.57 | **Repo cutover** — canonical home is now https://github.com/crossworks-engineering/mantle (full history + tags); TitanKing kept as `titanking` mirror remote; all doc URLs updated. |
| v0.20.58 | **Local-embedder sub-batching** — prod incident fix: 68-chunk architecture.md re-index timed out the single-request 60s window on CPU-only Ollama and retry-looped (high CPU); the adapter now sends sequential batches of 16 with a 120s window, retries resume from the embed cache. Also reclaimed 35GB of Docker build cache (53→27GB used). |
| v0.20.59 | **Measured VPS sizing** — deploy.md §0a: min 2vCPU/4GB (registry-pull), rec 4vCPU/8GB (build-on-VPS), stack idles at ~2.5GB. |

## Current state

- **Prod** (`ssh mantle-prod`, ~/mantle): **v0.20.58**, 13 containers healthy
  (v0.20.59 is docs-only, rides the next code deploy).
  Backup schedule enabled (daily 02:00 Africa/Johannesburg, keep 7); one
  verified manual dump in `~/mantle/data/backups`. Jason's personal offsite
  pull lives OUTSIDE the repo (`~/Backups/mantle/pull-prod-backup.sh`,
  launchd daily 08:15) — do not re-add it to source.
- **Dev**: same code; dev digests backfilled; legacy extract markers stamped.
- Full audit findings (~35, with file:line evidence) live in this session's
  transcript; the durable subset is §5 of
  [`docs/handover-trust-model.md`](./docs/handover-trust-model.md)
  ("already fixed" + "still open" lists).

## Next work, in priority order

0. **The marketing website** — [`docs/handover-website.md`](./docs/handover-website.md).
   Jason is starting this next: Next.js + the same 42-theme system, the
   Bukhari wordmark, README.md as the canonical copy. Docs links point at
   https://github.com/crossworks-engineering/mantle.
1. **Embodied companion / networked MCP** — [`docs/handover-embodied-companion.md`](./docs/handover-embodied-companion.md).
   The robot-with-an-H200 case: a `robot` conversation channel (personality
   over the wire — same Saskia, new body), then Streamable-HTTP MCP with
   bearer auth, then an optional `converse` MCP tool. Includes the
   fact-check that the claimed HTTP transport never existed in code.
1. **The trust model** — [`docs/handover-trust-model.md`](./docs/handover-trust-model.md).
   Self-contained brief: attack surfaces with evidence, 9-point design,
   sequencing (quick defaults first: `run_terminal` env scrub + confirm,
   `*_delete` gating), verification ideas.
2. Two-stage vector ranking (every brain `ORDER BY` defeats its HNSW index —
   silent seqscan cliff at scale).
3. Conversation→facts pathway (dialog never becomes shared durable memory;
   `builtins-persona.ts` tells agents it does).
4. Smaller: retrieval cutoffs vs embedder swaps, classifier fail-open→ADD,
   idle-stream digest flush, anaphora `slice(0,400)` inversion,
   `recall_window` `channel='web'` hardcode.

## Verification shortcuts

- `/debug/integrity` — should be clean/low on both envs (now includes
  `backup_stale` + `extract_dead_letter`).
- Cache fix: after a few real back-and-forth turns, query #3 in
  [`docs/audit-chat-cost-2026-06-07.md`](./docs/audit-chat-cost-2026-06-07.md) —
  first calls of follow-up turns should show `cache_read ≈ 20K`.
- Recall: ask Saskia to recall a past topic → Remy's `find_window` should
  return ranked windows (was always empty before v0.20.46).
- Backups: `cat ~/Backups/mantle/prod/last-success` on the Mac;
  /settings/backups status banner on either env.
