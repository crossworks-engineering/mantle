# Brain-core deploy profile (jackdaw split P4) — handover

> **Status 2026-08-14: BUILT.** Shipped as `docker-compose.core.yml`, an
> override that gates browser + the six channel workers (email/telegram/
> microsoft/calendar/push/runs) behind a `full` profile; a core box persists
> `COMPOSE_FILE=<abs>/docker-compose.yml:<abs>/docker-compose.core.yml` in
> .env via `scripts/install.sh --core` (absolute paths are load-bearing: the
> updater runs compose from cwd=/, and compose resolves a relative
> COMPOSE_FILE against cwd — verified against docker:28-cli, compose
> v2.40.3, and host v5.3.1). Core keeps api (the extract listeners live
> there, so ingest needs it) and worker_files/docs/events/maintenance;
> MCP is served by web. The doc helpers (tika + browser) sit behind a
> second `helpers` profile: `install.sh --helpers` re-adds them via
> COMPOSE_PROFILES (common formats parse in-process without tika). Bundled everywhere the release-owned composes
> travel: Dockerfile /app/release, release.yml bundle, bootstrap install.sh
> (fetch + baseline), compose-adopt.sh, updater refresh + stack.json.
> Drift guard: packages/content/src/invariants.test.ts. Docs:
> self-hosting.md "Brain-core shape", deploy.md §0a row, .env.prod.example.
> REMAINING: live validation on a small box (sign up, MCP file ingest,
> search, share link, measured RSS vs the 4 GB claim) — needs a box and
> Jason's go-ahead.

**Goal.** A SMALL deploy shape for headless memory cores: a full Mantle brain
(HTTP API + MCP + share pages + ingest) on a 2 vCPU / 4 GB box with online
embeddings — e.g. a dedicated core for meeting recordings that a main brain
queries over federation (`mantle_peer`) and any MCP agent (Claude Desktop)
uses directly. It must not degrade the full shape, and it must not break the
~5 existing fleet boxes that run `docker compose up -d` with no profiles.

## Where things stand (2026-08-14)

The repo split is DONE end to end (docs/plans/jackdaw-repo-split.md; dev-brain
page `0853dd11-bac0-43c9-be0e-635578cfa1ed`, task `c978b023`). This repo is the
brain: mantle main is at v0.230.44 (pushed), the server images build green,
and the frontend lives in crossworks-engineering/jackdaw consuming
`@crossworks/*` from npm. The brain compose has no client dependency; the
deploy bundle ships `docker-compose.client.yml` pulling
`titanwest/mantle-client` (built by jackdaw, pinned by
`MANTLE_CLIENT_IMAGE_TAG`, default `latest`).

## The problem P4 solves

`docker-compose.yml` always starts everything: postgres, minio, tika (1.5g),
browser (1.5g), web (1.5g), api (1.5g), caddy, updater, autoheal, and TEN
workers at 1g caps each — mem_limit sum ≈ 15 GB. Caps are guardrails, not
reservations, but a 4 GB box still cannot carry the resident set of ~17 node
processes. A memory core needs roughly: postgres, minio + createbuckets,
migrate, web, caddy — plus ingest workers matched to its purpose.

## Existing mechanics to build on (do not invent parallel machinery)

- Compose profiles already exist: `local-embedder` (ollama + ollama_pull),
  `sandboxes` (sandboxd), `tailnet` (tailscale). Everything else is
  profile-less, i.e. always on.
- `scripts/install.sh` persists profile choices via `COMPOSE_PROFILES` in the
  box `.env` (see the `local-embedder` handling around line 600) so updater
  pulls/ups keep them. Follow that pattern.
- **The back-compat trap**: services WITH a `profiles:` key do not start on a
  bare `docker compose up -d`. Putting existing workers behind a new `full`
  profile would silently stop them on every already-deployed box at its next
  update. Any design must keep the default shape byte-compatible: a bare `up`
  on an existing box must behave exactly as today.

Design directions to weigh (pick in-session):
1. `COMPOSE_PROFILES` cannot subtract, so a `core` profile cannot turn
   services OFF — only a second compose FILE can. Likely shape: a
   `docker-compose.core.yml` that lists ONLY the core services (or overrides
   with `deploy.replicas: 0` / omits the rest), installed by
   `install.sh --core`.
2. Decide the core service set. Certain: postgres, minio, createbuckets,
   migrate, web (serves HTTP API + MCP + /s shares), caddy, updater?,
   autoheal. Decide per-purpose: worker_files + worker_docs (file/docs
   ingest — likely core), tika + browser (file extraction deps — read
   docker-compose.yml comments for which ingest paths need them), api (DBOS
   assistant turns — needed if the core answers chat, not needed for pure
   ingest+MCP-query cores?  VERIFY: the MCP query path may run through web
   only), worker_events, worker_maintenance (nightly upkeep — probably keep,
   it is cheap), and the channel workers (email/telegram/microsoft/calendar/
   push/runs — off by default for a core).
3. Update `.env.prod.example`, `docs/self-hosting.md`, `docs/deploy.md`;
   consider a `scripts/install.sh --core` flag mirroring `--local-embedder`.
4. Validate: bring the core shape up on a small box (or locally with
   constrained limits), sign up, ingest a file over MCP, `search` it, open a
   share link. Measure actual RSS; the target claim is "fits 4 GB with online
   embeddings".

## References

- docker-compose.yml header comments (the per-service rationale is thorough).
- docs/self-hosting.md (box sizing, local-embedder caveats), docs/deploy.md.
- scripts/install.sh + scripts/dev-compose.sh (worktree/compose footguns: the
  root CLAUDE.md section on the dev stack is mandatory reading).
- Split plan P4 section: docs/plans/jackdaw-repo-split.md.

## Rules of the road for the session

- Work in a fresh worktree (`scripts/new-worktree.sh brain-core-profile`),
  land via `scripts/merge-branch.sh`, push only when asked.
- Repo is public: no client names/hostnames/IPs in commits or docs.
- The dev stack belongs to the original clone — never run compose from a
  worktree (see root CLAUDE.md for the 2026-08-01 incident).
- Deploys to fleet boxes need Jason's confirmation.
