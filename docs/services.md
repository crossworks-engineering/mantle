# Optional services: start and stop from Settings

Two parts of a box are optional, and an admin can switch each one on or off
from **Settings > Services** (`/settings/services`, admins only). The System
vitals pills on the dashboard show each one's state and link there:

| service       | what it does                                                                                                                | download                                                                                        | memory                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Sandboxes** | Isolated workspaces where the coder and app agents run code, build apps and test packages ([sandboxes.md](sandboxes.md)).   | about 430 MB (the sandbox base image; the supervisor uses the server image the box already has) | 512 MB, plus up to 1 GB for each running sandbox (3 at a time) |
| **Media**     | Transcripts from video and audio (links or files), and CAD drawings: DWF, DWG and DXF ([video-ingest.md](video-ingest.md)). | about 300 MB                                                                                    | up to 1 GB (3 GB is advised for large DWF sets)                |

Both are compose **profiles** (`sandboxes`, `media`). A switch changes the
box's `.env` and starts or stops ONE container; the rest of the brain keeps
running.

**Off never removes anything.** Switching sandboxes off stops the running
sandbox containers (stop, not remove) and the supervisor. Every sandbox, its
`/files` directory, its apps and services, the tokens and the images stay. On
again brings them back. Media stores nothing of its own; everything it
already ingested stays in the brain.

## Who can switch

Admin logins only: `POST /api/services/:name` uses the same gate as an
update request (`getOwnerOr401`). Members, clients, MCP tokens and agents have
no path to it, and there is no agent tool for it (an agent must not be able
to give itself a sandbox). Each request writes a `service.toggle` row to the
audit log with the service, the switch and whether the updater took it.

## How it works

```
Settings > Services ─POST /api/services/media {enable}─▶ web
web ─writes─▶ /signal/service-request.json            (only name + boolean)
updater sidecar ─reads, whitelists, runs─▶ docker compose on the host
updater ─writes─▶ /signal/service-status.json, service.log, services.json
every app container ─reads (mounted read-only)─▶ /signal/services.json
```

- **The one source of truth** for "is this service on" is
  `packages/config/src/services.ts` (`serviceEnabled`). On = the profile is
  active AND the URL and token are set. It reads the profile from the
  updater's live `services.json` first, then from `MANTLE_COMPOSE_PROFILES`
  (what compose gave the container), and only on a dev process outside
  compose from the token alone. A switch does not recreate the app
  containers, so their env would go stale; the live file is what they see
  change. The dashboard pills, `/api/sandboxes`, the sandbox tools,
  `video_ingest`, the DWG/DWF path and the agent tool list all read it.
- **Tools hide when a service is off.** `effectiveToolSlugs`
  (`packages/runtime/src/agent/skills.ts`) leaves `sandbox_*` and
  `video_ingest` out of an agent's tools while their service is off. The
  grant stays, so they come back the moment the service is on. The MCP
  surface keeps listing the sandbox tools on purpose; they answer that the
  service is switched off and that an admin can switch it on.
- **The updater verb** (`infra/updater/updater.sh`, `handle_service_request`)
  takes a service name from a fixed list and a boolean, nothing else. It
  uses a request file of its own, so an older updater that does not know the
  verb never reads it (the same body in `request.json` would mean "roll to
  latest"). The brain offers the switch only when the updater lists
  `service` in the `verbs` of `services.json`.
- **One change at a time.** A switch is refused while an update runs, and
  an update while a switch runs.

### Switching on

1. Free-disk check: at least `MANTLE_SERVICE_MIN_FREE_MB` (default 4096) on
   the stack's filesystem, or the request is refused with nothing changed.
2. `.env` is backed up to `backups/env/.env-<time>` (newest 5 kept, owner and
   mode kept).
3. The service's token is written when missing (64 hex characters from the
   kernel). For sandboxes, `MANTLE_SANDBOXES_HOST_DIR` is set to
   `<data dir>/sandboxes`, host-absolute, when missing.
4. The profile is added to `COMPOSE_PROFILES`.
5. Only that service's image is pulled (for sandboxes, also the sandbox base
   image; a failure there is not fatal, the first new sandbox fetches it).
6. Only that container starts (`up -d --no-deps`). If the token was only
   just written, the app containers are recreated once so they carry it; a
   normal roll writes both tokens in advance, so this is rare.
7. The updater waits up to `MANTLE_SERVICE_HEALTH_TIMEOUT_S` (default 180)
   for the container to report healthy.

Any failure in steps 3 to 7 puts `.env` back from the backup and stops the
container again. Settings > Services shows the reason and the log.

### Switching off

1. `.env` is backed up.
2. Sandboxes only: running sandbox containers (label `mantle.sandbox=true`)
   are stopped. Never removed.
3. The service container is stopped and removed (the container, not its
   data: neither service keeps data in its container).
4. The profile is dropped from `COMPOSE_PROFILES`.

If a stop fails, `.env` is left as it was and Settings > Services says so.

## Tokens are provisioned in advance

A roll writes `SANDBOXD_TOKEN` and `MEDIA_SIDECAR_TOKEN` into `.env` when they
are missing, whether or not the service is on (`ensure_service_tokens`), and
`scripts/install.sh` does the same on install. A token alone is inert: the
profile decides what runs, and the brain reads the profile. Having the token
in the app containers' env from the start is what lets a later switch start
one container instead of restarting the brain. A token is never rotated.

The updater provisions tokens only on a compose whose app services mount
`/signal` read-only, because a brain older than that reads "token set" as
"on". Rolling such a box back to an older release after its tokens exist
shows the off services as red ("not answering") pills; nothing else changes.

## Small boxes

On a box with 6 GB of memory or less, or the 4 GB core shape
(`docker-compose.core.yml`), the switch stays available and Settings > Services
shows a clear memory warning first. The admin decides.

## Files

| file                           | written by | what                                                                                                                          |
| ------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `/signal/services.json`        | updater    | profiles, per-service token presence (never the value), container state and health, host memory, free disk, core shape, verbs |
| `/signal/service-request.json` | web        | the pending switch: `{service, enable, requested_at}`                                                                         |
| `/signal/service-status.json`  | updater    | `{phase, service, enable, started_at, finished_at, ok, error}`; phases `pulling`, `starting`, `stopping`, `done`, `error`     |
| `/signal/service.log`          | updater    | the last switch's output                                                                                                      |

Tests: `scripts/test-deploy-scripts.sh` (every updater input path: the
whitelist, on, off, each failure, the poll loop; also run inside the
`docker:28-cli` image), `server/web/lib/services.test.ts`,
`packages/config/src/services.test.ts`.
