# Versioning

Mantle uses [semantic versioning](https://semver.org/). The version is shown in
small text next to the **mantle** wordmark in the top bar, and served at
`/api/version` for ops/uptime probes.

## Scheme

Pre-1.0, the parts mean:

- **minor** (`0.19`) tracks **major feature milestones shipped** (ingest + tiered
  memory, knowledge graph, embeddings, pages, tables, contacts, email in/out,
  recall, researcher, federation, telegram, lifelogs, heartbeats, chat failover,
  tailscale inference, documentation, unified conversation, onboarding, …).
- **patch** (`.0`) — fixes/iterations within a milestone; resets each minor.
- **`-alpha`** — the system runs in production and is used daily, but it's
  single-user, makes no stability guarantees, and the schema is still churning
  (breaking migrations still land). That's alpha, honestly — not beta. The tag
  drops when those guarantees firm up.

## Single source of truth

The root [`package.json`](../package.json) `version` field. `apps/web/package.json`
is kept in lockstep so the two never drift.

Bump it with the helper (never hand-edit both files):

```bash
pnpm version:bump patch          # 0.19.0-alpha -> 0.19.1  (fixes)
pnpm version:bump minor          # 0.19.0-alpha -> 0.20.0  (new milestone)
pnpm version:bump major          # 0.19.0-alpha -> 1.0.0   (stable)
pnpm version:bump 0.19.3-alpha   # set explicitly (pre-release tag allowed)
```

`patch`/`minor`/`major` operate on the numeric core and drop any `-alpha` tag —
pass it back explicitly (`0.20.0-alpha`) to keep carrying it while pre-1.0.

Then commit and tag:

```bash
git commit -am "release: v0.2.0"
git tag v0.2.0
git push origin main v0.2.0   # the tag push cuts the release (see below)
```

> **Pushing a `v*` tag publishes a release.**
> [`.github/workflows/release.yml`](../.github/workflows/release.yml) builds the
> multi-arch image, pushes `titanwest/mantle:<tag>` + `:latest` to Docker Hub,
> and creates a GitHub Release with the deploy bundle. Self-hosters then see the
> new version in **Settings → Updates** (and the sidebar "Update available"
> chip). So the version bump isn't just cosmetic — the tag is the release
> trigger. See [`self-hosting.md`](./self-hosting.md).

## How it reaches the UI

Build identity is resolved once, at build/dev-start, in
[`apps/web/next.config.ts`](../apps/web/next.config.ts) and inlined as
`NEXT_PUBLIC_*` env so there's no runtime cost:

| value | source |
| --- | --- |
| `NEXT_PUBLIC_APP_VERSION` | root `package.json` `version` |
| `NEXT_PUBLIC_GIT_SHA` | `MANTLE_GIT_SHA` env, else `git rev-parse --short HEAD` |
| `NEXT_PUBLIC_BUILD_TIME` | `MANTLE_BUILD_TIME` env, else build wall-clock (UTC ISO) |

[`apps/web/lib/version.ts`](../apps/web/lib/version.ts) reads them (client +
server safe) and exposes `VERSION_LABEL` (`v0.19.0-alpha`) for the wordmark and
`versionDetail()` (`v0.19.0-alpha · 5a96bcd · 2026-06-05`) for the hover tooltip.

## Docker builds

`.git` is excluded from the build context ([`.dockerignore`](../.dockerignore)),
so the build can't run `git` inside the image. The build script resolves the SHA
+ time on the host and passes them in as build args:

- [`scripts/docker-build-push.sh`](../scripts/docker-build-push.sh) stamps
  `MANTLE_GIT_SHA` (short HEAD) and `MANTLE_BUILD_TIME` (UTC ISO).
- [`docker-compose.yml`](../docker-compose.yml) forwards them as `build.args`.
- The [`Dockerfile`](../Dockerfile) `app` stage turns those ARGs into ENV before
  `next build`, so `next.config.ts` picks them up.

A bare `docker build .` with no args still works — the SHA/time are simply
omitted from the label.
