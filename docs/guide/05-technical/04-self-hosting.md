# Self-hosting

Mantle is self-hosted by design — you run it, you own the data. This page is the
orientation; the step-by-step operator runbooks live in the repo's developer docs.

## Two environments

- **Development** — on your own machine. Infrastructure (Postgres + object storage +
  a document parser) runs in Docker; the app and workers run with hot-reload. One
  command brings it up.
- **Production** — on a small server (a VPS works fine). The whole stack runs as
  Docker containers behind a reverse proxy that handles HTTPS automatically.

## What persists

Three things hold all your state; everything else is rebuildable from source:

- The **Postgres** database (every node, fact, and setting).
- The **object store** (attachment bytes).
- The **files folder** (your mirrored Files tree).

In production these are bind-mounted to disk so they survive container rebuilds.
Backups are a database dump plus a copy of those folders.

## A few operator essentials

- **Secrets that must stay constant:** the master encryption key and your owner id
  must match between environments, or data encrypted on one (API keys, secrets)
  won't decrypt on the other. Treat the master key like the crown jewels — losing it
  means losing the encrypted vault.
- **Migrations run on boot** in production (a one-shot step before the app starts),
  and are forward-only — so take a database dump before updating.
- **Updating** is `docker compose pull && docker compose up -d --wait`, or one click
  in **Settings → Updates**; the data volumes carry over. (Self-builders who run their
  own image build on the server rebuild instead of pulling.)
- **Models:** a single OpenRouter key gets the brain fully working; embeddings run
  locally and free. You can add local model machines on your own network for privacy
  (see [keys, embedding & local models](../04-configuring/04-keys-embedding-local-models.md)).

## The runbooks

For the actual commands and checklists, see these developer docs in the repo:

- `docs/deploy.md` — first-time production deploy.
- `docs/update-prod.md` — the pull-and-roll update flow.
- `docs/tailscale.md` — connecting model machines on your own network.
- `docs/architecture.md` §Operations — backups, secret rotation, disaster recovery.

These are infrastructure-level and intended for whoever operates the box (likely
you). They're part of the built-in **System docs** collection — disabled by default,
enable-able at [the Docs page](../04-configuring/05-documentation-collections.md)
if you want the assistant to answer deployment questions too.
