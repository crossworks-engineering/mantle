# TWO Mantle images from one file:
#
#   --target server → mantle-server: every backend service — API/web host,
#     DBOS runner, the workers, one-shot migrate — same image, different
#     compose `command:` per service (docker-compose.yml).
#   --target parser → mantle-parser: the parser service (server/parser), the
#     one container that reads every untrusted file: the workspace's readers
#     (Node), the CAD tier (Python: ezdxf, ezdwf, ezdwg, matplotlib, and the
#     dwg2dxf binary) and ffmpeg. It replaced Apache Tika and the media
#     sidecar (2026-10).
#   (the owner-UI / client image moved to the mantle-client repo at the split)
#
# Build:  docker build --target server -t <ns>/mantle-server:<tag> .
#         docker build --target parser -t <ns>/mantle-parser:<tag> .
# One MANTLE_IMAGE_TAG drives both composes — releases are lockstep.
#
# Note: server/mcp is intentionally NOT run here. The MCP server is stdio-only
# (StdioServerTransport) — a detached daemon would hit EOF on stdin and
# crash-loop. It runs as a subprocess of whatever launches it (Claude Desktop)
# until the HTTP transport lands. See docs/architecture.md §16.
#
# We keep dev deps (tsx, next, typescript) in the image so the agent + workers
# run TypeScript directly via tsx in production. At personal scale the image-size
# cost is fine; the operational simplicity is worth more.

# ── 1. modules: the workspace's installed dependencies (no source yet) ──────
# Node 26 — the current line, adopted 2026-07-25 for the V8 14.6 performance
# work. It is NOT yet LTS: 26 is an even-numbered line and promotes to Active
# LTS around Oct 2026, at which point this pin simply becomes the LTS pin. Until
# then we ride "current", so watch the release notes on minor bumps.
# pnpm 11.28.5 (pinned in packageManager) imports a Node builtin not present in
# Node 20, so node:20-slim fails install with ERR_UNKNOWN_BUILTIN_MODULE; 26 is
# safely above that. corepack is unbundled from Node 25+, so we install pnpm via
# npm directly.
FROM node:26-slim AS modules
WORKDIR /app
# pnpm 11 checks the installed dependencies before `pnpm run` and `pnpm
# exec` (the CMDs below and every compose service start that way), and by
# default INSTALLS when it finds them out of date: on a box, at container
# start, with lifecycle scripts, from the network (or, in the parser, with
# none). An image's dependencies are the frozen install below and nothing
# else, so a mismatch is an image bug: `error` refuses to start with the
# reason instead. Set as an env var (pnpm reads `pnpm_config_*`, not
# `npm_config_*`), so the images only: a developer's `pnpm dev` keeps
# pnpm's install-before-run.
ENV pnpm_config_verify_deps_before_run=error

# Copy manifests first so the install layer is cached when only source changes.
# This list MUST contain every workspace package.json (server/* + packages/*) or
# `pnpm install --frozen-lockfile` below fails ("missing"/"lockfile mismatch")
# because the workspace it sees doesn't match the lockfile. `pnpm arch:check`
# fails when it differs from the workspace (scripts/arch-scoreboard.ts,
# dockerfileManifestProblems), so a new package is added here in the same
# change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# pnpm-workspace.yaml's `patchedDependencies` are resolved DURING install, so
# every patch file must already be in the context. A missing one is a hard
# ENOENT that fails all four arch builds identically, and it fails here — in the
# cached manifest layer — where the cause is furthest from the symptom. Adding a
# patch means adding nothing here (the whole dir is copied), but removing this
# line breaks every build that has one.
COPY patches patches
COPY server/api/package.json server/api/package.json
COPY server/mcp/package.json server/mcp/package.json
COPY server/parser/package.json server/parser/package.json
COPY server/sandboxd/package.json server/sandboxd/package.json
COPY server/web/package.json server/web/package.json
COPY packages/api-keys/package.json packages/api-keys/package.json
COPY packages/app-build/package.json packages/app-build/package.json
COPY packages/calendar/package.json packages/calendar/package.json
COPY packages/client-types/package.json packages/client-types/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/content/package.json packages/content/package.json
COPY packages/content-core/package.json packages/content-core/package.json
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/decisions/package.json packages/decisions/package.json
COPY packages/diagram-templates/package.json packages/diagram-templates/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/embeddings/package.json packages/embeddings/package.json
COPY packages/files/package.json packages/files/package.json
COPY packages/mcp-core/package.json packages/mcp-core/package.json
COPY packages/microsoft/package.json packages/microsoft/package.json
COPY packages/rules/package.json packages/rules/package.json
COPY packages/runs/package.json packages/runs/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/search/package.json packages/search/package.json
COPY packages/share-ui/package.json packages/share-ui/package.json
COPY packages/std/package.json packages/std/package.json
COPY packages/storage/package.json packages/storage/package.json
COPY packages/tabledb/package.json packages/tabledb/package.json
COPY packages/telegram/package.json packages/telegram/package.json
COPY packages/tools/package.json packages/tools/package.json
COPY packages/tracing/package.json packages/tracing/package.json
COPY packages/turn-stream/package.json packages/turn-stream/package.json
COPY packages/voice/package.json packages/voice/package.json
COPY packages/voice-client/package.json packages/voice-client/package.json

# Install the build toolchain (python3 / build-essential, needed to COMPILE
# native modules), pnpm, and the workspace — then PURGE the toolchain in the
# SAME layer so its ~340MB doesn't ship in the image. The compiled `.node`
# artifacts stay in node_modules; only the compiler is removed. ca-certificates
# is kept (runtime HTTPS). Caches are cleaned to keep the layer lean.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential ca-certificates \
    && npm install -g pnpm@11.28.5 \
    # ELECTRON_SKIP_BINARY_DOWNLOAD is vestigial: it existed because
    # client/desktop was a workspace member and dragged electron's ~100MB
    # binary into this image. The desktop app moved to the mantle-client repo on
    # 2026-08-13 and this workspace is server/* + packages/* only, so nothing
    # depends on electron any more. Kept as a cheap guard in case a transitive
    # dep ever reintroduces it.
    && ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile \
    && apt-get purge -y python3 build-essential && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.local/share/pnpm/store /root/.cache

# ── 1a. deps: the installed workspace plus its source (the server image's base)
FROM modules AS deps
COPY . .

# ── 1a⅞. ezdwg-build: the DWG fallback converter's wheel, both arches ───────
# PyPI ships ezdwg wheels for x86_64 only; on arm64 pip falls back to the
# sdist and tries to compile Rust inside the parser stage, which has no
# toolchain ("linker `cc` not found" — the v0.232.100 release failure). Build
# the wheel here instead, in maturin's official image (Rust toolchain plus
# manylinux Pythons for both amd64 and arm64): pinned PyPI sdist,
# checksum-locked like the LibreDWG tarball.
FROM ghcr.io/pyo3/maturin:v1.15.0 AS ezdwg-build
ADD --checksum=sha256:e802447b528b0341e4715fa8bdb2722183ba3456d49a4feab66d0690c5d96be0 \
  https://files.pythonhosted.org/packages/42/91/fb24addea0c5e4572a11dcd874d0cb4ce924058978ea7d59ffd29efde387/ezdwg-0.17.0.tar.gz /tmp/ezdwg-sdist.tar.gz
RUN mkdir /tmp/ezdwg \
  && tar -xzf /tmp/ezdwg-sdist.tar.gz -C /tmp/ezdwg --strip-components=1
WORKDIR /tmp/ezdwg
# The wheel is abi3 (pyo3 abi3-py310), so the interpreter only drives the
# build; the parser stage's Python (Debian's) installs it as it is.
RUN maturin build --release --interpreter python3.15 --out /wheels

# ── 1a¾. libredwg-build: static dwg2dxf for the DWG tier ────────────────────
# Debian ships no libredwg package, so the converter is built from the pinned
# GNU release tarball. GPLv3: it enters the parser image as a standalone
# BINARY invoked via subprocess only — the process boundary is the licence
# boundary; never link or bind it into anything. --disable-werror because
# newer GCCs flag warnings the release predates; python3 satisfies
# configure's interpreter check, and 0.14's configure also requires
# pkg-config. Built on the parser's own base (node:26-slim, Debian), so the
# binary links against the glibc it runs on. The tarball comes from the
# kernel.org GNU mirror, not ftp.gnu.org: the primary timed out for whole
# release runs (v0.239.15). The checksum pins the exact bytes, so the
# mirror cannot change what we build.
FROM node:26-slim AS libredwg-build
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc make libc6-dev pkg-config python3 xz-utils \
  && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275 \
  https://mirrors.kernel.org/gnu/libredwg/libredwg-0.14.tar.xz /tmp/libredwg.tar.xz
RUN mkdir /tmp/libredwg \
  && tar -xJf /tmp/libredwg.tar.xz -C /tmp/libredwg --strip-components=1
WORKDIR /tmp/libredwg
RUN ./configure --disable-shared --disable-bindings --disable-docs --disable-werror \
    --prefix=/opt/libredwg \
  && make -j"$(nproc)" \
  && make install-strip

# ── 1b. parser-base: the parser's programs, BEFORE any source ──────────────
# ffmpeg, the CAD tier's Python and the dwg2dxf binary depend on nothing in
# the source tree, so they are installed on the `modules` stage: these layers
# are rebuilt when the lockfile or this block changes, not on every release.
FROM modules AS parser-base
ENV NODE_ENV=production
# ffmpeg for the audio extract; Debian's python3 + venv for the CAD tier.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
# CAD tier: ezdwf (MIT, Rust wheel) renders Autodesk DWF plot-set sheets;
# matplotlib is its raster backend. ezdxf parses and renders the DXF (the one
# code path downstream of conversion); ezdwg is the MIT fallback converter for
# files dwg2dxf mangles. All pinned: their versions decide the rendered
# pixels, and ezdwf is pre-alpha. ezdwg installs from the ezdwg-build stage's
# wheel, never PyPI: PyPI has no arm64 wheel and this stage has no compiler.
COPY --from=ezdwg-build /wheels /tmp/ezdwg-wheels
RUN python3 -m venv /opt/cad \
    && /opt/cad/bin/pip install --no-cache-dir --only-binary ezdwf "ezdwf==0.0.9" \
       /tmp/ezdwg-wheels/ezdwg-*.whl "matplotlib==3.11.2" "ezdxf==1.4.5" \
    && rm -rf /tmp/ezdwg-wheels /root/.cache
COPY --from=libredwg-build /opt/libredwg/bin/dwg2dxf /usr/local/bin/dwg2dxf
# No MPLCONFIGDIR here: each job gets its own, inside the job's directory
# (server/parser/src/proc.ts jobEnv), so no job reads a cache another left.
ENV PARSER_PYTHON=/opt/cad/bin/python \
    MPLBACKEND=Agg

# ── 1c. parser: the parser service (server/parser) ─────────────────────────
# The readers are the workspace's own modules (@mantle/files/readers/*) and
# their dependencies (pdfjs, exceljs, mammoth, anydoc, canvas). It runs no
# build step, carries no secret (PARSER_TOKEN is its only one) and mounts no
# data. Compose gives it its memory limit, its CPU share, a tmpfs for its
# scratch space and a network with no route out (docker-compose.yml); the
# service itself runs every job in its own process (docs/parser.md).
FROM parser-base AS parser
COPY . .
# Compose runs this image with a read-only root filesystem and a tmpfs on
# /tmp, where the server keeps nothing: the check after every job wants
# the empty job root alone there (docs/parser.md, "Between jobs"). So no
# tsx transform cache and no Node compile cache, for the server and its
# jobs alike (each job's own caches sit in its directory, proc.ts jobEnv).
ENV TSX_DISABLE_CACHE=1 \
    NODE_DISABLE_COMPILE_CACHE=1
# The base image's unprivileged user: a job that breaks out of its reader
# still holds no root and no write access to the workspace.
USER node
EXPOSE 8095
# The exec form (pnpm … exec), as the server image: SIGTERM reaches the
# server's handler. Node with tsx's loader, not the `tsx` command: that one
# stays as a parent process and keeps an IPC socket in /tmp (tsx-<uid>),
# which the check after every job would find.
CMD ["pnpm", "-C", "server/parser", "exec", "node", "--import", "tsx", "src/main.ts"]

# ── 2. server: backend runtime image — workspace + generated assets ─────────
# Carries source + node_modules + the generated runtime assets (app-runtime,
# share-runtime, route manifest), so the SAME image can run the Hono web
# server (tsx), the agent, the tsx workers, and the migrator — selected by the
# compose `command:` per service. Defaults to the web server. There is no
# compile step: server/web runs raw TypeScript under tsx, like server/api and
# every worker always have.
FROM deps AS server
ENV NODE_ENV=production
# The checks' floor (migration 0301): migrate raises a check below on that no
# recorded lowering covers. A box kept below on on purpose sets keep in its
# .env (docs/update-prod.md, "Keep one box below on, on purpose").
ENV MANTLE_CHECK_FLOOR=raise
# pg_dump for the scheduled-backup feature (/settings/backups). Must be the
# pgdg client — the distro default lags (bookworm shipped 15, trixie 17), and
# pg_dump refuses servers newer than itself. The repo codename is DERIVED from
# the base image, not hardcoded: node:24-slim was bookworm, node:26-slim is
# trixie, and a stale hardcoded codename fails the apt install outright (that
# is exactly what the Node 24 → 26 bump hit). curl is installed and purged in
# the same layer; the pgdg keyring + client stay.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && . /etc/os-release \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] http://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-18 \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*
# NOTE: no browser in this image. The Pages → PDF export drives the `browser`
# compose sidecar (browserless/chromium) over websocket via puppeteer-core —
# see server/web/lib/render-pdf.ts and the compose service definition.
# Build identity — surfaced next to the wordmark + at /api/version. `.git` is
# excluded from the build context (.dockerignore), so next.config.ts can't read
# the SHA inside the image; the build script (scripts/docker-build-push.sh)
# passes it in. Empty defaults keep a bare `docker build .` working.
ARG MANTLE_GIT_SHA=""
ARG MANTLE_BUILD_TIME=""
ENV MANTLE_GIT_SHA=$MANTLE_GIT_SHA
ENV MANTLE_BUILD_TIME=$MANTLE_BUILD_TIME
# Generate the runtime assets: mini-app runtime (public/app-runtime), the
# route manifest, and the share-runtime bundle (Tailwind styles + share
# islands + KaTeX) for the server-rendered /s + /print surfaces.
RUN pnpm -C server/web build
# Release-owned deploy files, embedded so (a) the updater sidecar can extract
# the CANONICAL docker-compose.yml for this exact release from the already-
# pulled image (in-band — no extra network fetch) and refresh a pristine box
# copy, and (b) the web app can fingerprint the canonical to flag compose
# drift on /settings/updates. Kept AFTER the build layer: compose edits must
# not invalidate the (expensive) asset-generation cache. See
# infra/updater/updater.sh (compose refresh) + docs/deploy.md.
COPY docker-compose.yml /app/release/docker-compose.yml
COPY docker-compose.client.yml /app/release/docker-compose.client.yml
COPY docker-compose.core.yml /app/release/docker-compose.core.yml
COPY infra/caddy/Caddyfile /app/release/Caddyfile
COPY infra/caddy/shapes /app/release/caddy-shapes
COPY infra/updater/updater.sh /app/release/updater.sh
# The OPERATOR scripts a box runs by hand (db-dump, db-restore, sanity,
# compose-adopt, uninstall) and the configurator install.sh delegates to.
# Release-owned like compose and the Caddyfile since v0.232.137: until then a
# box ran whatever install.sh fetched the day it was built, FOREVER, because
# nothing refreshed scripts/. That is not theoretical — jason-prod's
# compose-adopt.sh was three releases stale, so `--apply` installed a compose
# binding infra/caddy/{shapes,conf.d} while knowing nothing about either, and
# the next `up -d` would have had Docker create both as root-owned strays with
# the front door still on the old Caddyfile. See infra/updater/updater.sh
# (refresh_scripts) + docs/deploy.md.
COPY scripts/db-dump.sh /app/release/scripts/db-dump.sh
COPY scripts/db-restore.sh /app/release/scripts/db-restore.sh
COPY scripts/install.sh /app/release/scripts/install.sh
COPY scripts/sanity.sh /app/release/scripts/sanity.sh
COPY scripts/compose-adopt.sh /app/release/scripts/compose-adopt.sh
COPY scripts/uninstall.sh /app/release/scripts/uninstall.sh
COPY scripts/onboard.sh /app/release/scripts/onboard.sh
# The jackdaw client tag this server release was tested against (the "release
# pair"). The updater reads it from the TARGET image during a roll and moves
# the client stack to it — the client image versions on its own stream since
# the repo split, so without this the client either floats on :latest
# (untested pairings) or sits on a hand pin forever (no UI updates).
COPY client-pair.tag /app/release/client-tag
EXPOSE 3000
# `pnpm … exec` (NOT the run-script form): `pnpm run start` interposes an
# `sh -c` layer that swallows SIGTERM, so compose stop/update would never reach
# the server's graceful-shutdown handler and every stop would burn the full
# grace period before SIGKILL — verified empirically in the v0.202.0 audit.
# The exec form forwards signals through tsx to node (same as the old
# `pnpm exec next start` CMD and every worker service).
CMD ["pnpm", "-C", "server/web", "exec", "tsx", "server/main.ts"]

# The owner-UI (client) image moved to the mantle-client repo at the split
# (2026-08-13): https://github.com/crossworks-engineering/mantle-client
