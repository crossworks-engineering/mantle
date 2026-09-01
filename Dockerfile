# TWO Mantle images from one file (v0.200.0 split):
#
#   --target server → mantle-server: every backend service — API/web host,
#     DBOS runner, the workers, one-shot migrate — same image, different
#     compose `command:` per service (docker-compose.yml).
#   (the owner-UI / client image moved to the jackdaw repo at the split)
#
# Build:  docker build --target server -t <ns>/mantle-server:<tag> .
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

# ── 1. deps: full workspace install ─────────────────────────────────────────
# Node 26 — the current line, adopted 2026-07-25 for the V8 14.6 performance
# work. It is NOT yet LTS: 26 is an even-numbered line and promotes to Active
# LTS around Oct 2026, at which point this pin simply becomes the LTS pin. Until
# then we ride "current", so watch the release notes on minor bumps.
# pnpm 11.1.2 (pinned in packageManager) imports a Node builtin not present in
# Node 20, so node:20-slim fails install with ERR_UNKNOWN_BUILTIN_MODULE; 26 is
# safely above that. corepack is unbundled from Node 25+, so we install pnpm via
# npm directly.
FROM node:26-slim AS deps
WORKDIR /app

# Copy manifests first so the install layer is cached when only source changes.
# This list MUST contain every workspace package.json (server/* + packages/*) or
# `pnpm install --frozen-lockfile` below fails ("missing"/"lockfile mismatch")
# because the workspace it sees doesn't match the lockfile. Keep it in sync when
# adding a package — verify with:
#   diff <(grep -oE '(server|packages)/[a-z-]+/package.json' Dockerfile | sort -u) \
#        <(find server packages -maxdepth 2 -name package.json -not -path '*/node_modules/*' | sort -u)
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
COPY server/sandboxd/package.json server/sandboxd/package.json
COPY server/web/package.json server/web/package.json
COPY packages/agent-runtime/package.json packages/agent-runtime/package.json
COPY packages/api-keys/package.json packages/api-keys/package.json
COPY packages/app-build/package.json packages/app-build/package.json
COPY packages/assistant-runtime/package.json packages/assistant-runtime/package.json
COPY packages/calendar/package.json packages/calendar/package.json
COPY packages/client-types/package.json packages/client-types/package.json
COPY packages/content/package.json packages/content/package.json
COPY packages/content-core/package.json packages/content-core/package.json
COPY packages/crypto/package.json packages/crypto/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/embeddings/package.json packages/embeddings/package.json
COPY packages/files/package.json packages/files/package.json
COPY packages/heartbeats/package.json packages/heartbeats/package.json
COPY packages/mcp-core/package.json packages/mcp-core/package.json
COPY packages/microsoft/package.json packages/microsoft/package.json
COPY packages/rules/package.json packages/rules/package.json
COPY packages/runs/package.json packages/runs/package.json
COPY packages/search/package.json packages/search/package.json
COPY packages/share-ui/package.json packages/share-ui/package.json
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
    && npm install -g pnpm@11.1.2 \
    # ELECTRON_SKIP_BINARY_DOWNLOAD: client/desktop is a workspace member, so
    # its electron dep installs here too — skip the ~100MB binary download the
    # images never run (the desktop app is built by desktop.yml, not here).
    && ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile \
    && apt-get purge -y python3 build-essential && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.npm /root/.local/share/pnpm/store /root/.cache

# Now copy sources.
COPY . .

# ── 1a½. ezdwf-build: patched CAD-parser wheel for the media stage ──────────
# Stock ezdwf 0.0.3 peaks ~1.27 GB RSS reading a 630 KB DWF (eager Python
# materialization of the whole drawing). Until our lazy-read fix lands
# upstream, we build the wheel ourselves: pinned upstream source + the three
# patched files vendored in infra/media-sidecar/ezdwf-patch/ (see its README;
# the sha there and here move together). maturin's official image carries the
# Rust toolchain + manylinux Pythons for both amd64 and arm64.
FROM ghcr.io/pyo3/maturin:v1.15.0 AS ezdwf-build
ADD https://github.com/monozukuri-ai/ezdwf/archive/d134278004f527f3062bf49d7db7a8df3887fedc.tar.gz /tmp/ezdwf.tar.gz
RUN mkdir /tmp/ezdwf \
  && tar -xzf /tmp/ezdwf.tar.gz -C /tmp/ezdwf --strip-components=1
COPY infra/media-sidecar/ezdwf-patch/lib.rs /tmp/ezdwf/crates/ezdwf-python/src/lib.rs
COPY infra/media-sidecar/ezdwf-patch/document.py /tmp/ezdwf/src/ezdwf/document.py
COPY infra/media-sidecar/ezdwf-patch/raw.py /tmp/ezdwf/src/ezdwf/raw.py
WORKDIR /tmp/ezdwf
RUN maturin build --release --interpreter python3.12 --out /wheels

# ── 1a⅞. ezdwg-build: the DWG fallback converter's wheel, both arches ───────
# PyPI ships ezdwg wheels for x86_64 only; on arm64 pip falls back to the
# sdist and tries to compile Rust inside the media stage, which has no
# toolchain ("linker `cc` not found" — the v0.232.100 release failure). Build
# the wheel here instead, in the same maturin image the ezdwf stage already
# uses: pinned PyPI sdist (unpatched — unlike ezdwf there is no local fix),
# checksum-locked like the LibreDWG tarball.
FROM ghcr.io/pyo3/maturin:v1.15.0 AS ezdwg-build
ADD --checksum=sha256:c3a8109e3331dd52d1ecfff0533693899f114c184e687d42bcf0564dbb924218 \
  https://files.pythonhosted.org/packages/4e/93/927fc4b727e0ba0ce5b15d893fa1686e93ee6d4b78c1425c56b4b084907e/ezdwg-0.12.6.tar.gz /tmp/ezdwg-sdist.tar.gz
RUN mkdir /tmp/ezdwg \
  && tar -xzf /tmp/ezdwg-sdist.tar.gz -C /tmp/ezdwg --strip-components=1
WORKDIR /tmp/ezdwg
RUN maturin build --release --interpreter python3.12 --out /wheels

# ── 1a¾. libredwg-build: static dwg2dxf for the DWG tier ────────────────────
# Debian ships no libredwg package, so the converter is built from the pinned
# GNU release tarball. GPLv3: it enters the media image as a standalone
# BINARY invoked via subprocess only — the process boundary is the licence
# boundary; never link or bind it into anything. --disable-werror because
# newer GCCs flag warnings 0.13.3 predates; the python base satisfies
# configure's interpreter check.
FROM python:3.12-slim AS libredwg-build
RUN apt-get update \
  && apt-get install -y --no-install-recommends gcc make libc6-dev xz-utils \
  && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:83f1f6e78a744777a481ff4520e4cef3f8ac4b2c1c25671077ca12fe81e8816e \
  https://ftp.gnu.org/gnu/libredwg/libredwg-0.13.3.tar.xz /tmp/libredwg.tar.xz
RUN mkdir /tmp/libredwg \
  && tar -xJf /tmp/libredwg.tar.xz -C /tmp/libredwg --strip-components=1
WORKDIR /tmp/libredwg
RUN ./configure --disable-shared --disable-bindings --disable-docs --disable-werror \
    --prefix=/opt/libredwg \
  && make -j"$(nproc)" \
  && make install-strip

# ── 1b. media: yt-dlp + ffmpeg sidecar (independent of the node stages) ─────
# Deliberately NOT built on the node deps stage: this image runs a fast-moving,
# auto-updating, network-facing binary (yt-dlp) that parses hostile input from
# the open web, so it gets its own minimal Python base with no workspace code,
# no DB drivers, and no secrets. Source + safety model: infra/media-sidecar/.
# yt-dlp is baked in for offline boots, then refreshed from PyPI at start and
# daily by the entrypoint (see entrypoint.sh for why "always latest" is a hard
# requirement for this one dependency).
FROM python:3.12-slim AS media
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1001 media \
  && python -m venv /opt/venv \
  && chown -R media:media /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
USER media
RUN pip install --no-cache-dir yt-dlp
# CAD tier: ezdwf (MIT, Rust wheel) renders Autodesk DWF plot-set sheets to
# PNG for the /dwf/render route; matplotlib is its raster backend. Pinned —
# unlike yt-dlp, nothing here needs "always latest", and ezdwf is pre-alpha
# so an unreviewed bump could change render output under us. The wheel comes
# from the ezdwf-build stage above (0.0.3 + our lazy-read memory fix) instead
# of PyPI; revert to the plain PyPI pin once upstream ships the fix.
ENV MPLBACKEND=Agg
COPY --from=ezdwf-build /wheels /tmp/ezdwf-wheels
# DWG tier (v0.232.99): ezdxf parses + renders the converted DXF (the one
# code path downstream of conversion); ezdwg is the MIT fallback converter
# for files dwg2dxf mangles. Both pinned like ezdwf and for the same reason.
# ezdwg installs from the ezdwg-build stage's wheel, never PyPI: PyPI has no
# arm64 wheel and this stage has no compiler (the v0.232.100 arm64 failure).
COPY --from=ezdwg-build /wheels /tmp/ezdwg-wheels
RUN pip install --no-cache-dir /tmp/ezdwf-wheels/ezdwf-*.whl /tmp/ezdwg-wheels/ezdwg-*.whl \
    "matplotlib>=3.9,<4" "ezdxf==1.4.4"
COPY --from=libredwg-build /opt/libredwg/bin/dwg2dxf /usr/local/bin/dwg2dxf
COPY infra/media-sidecar/app.py /srv/app.py
COPY infra/media-sidecar/entrypoint.sh /srv/entrypoint.sh
EXPOSE 8095
ENTRYPOINT ["/bin/sh", "/srv/entrypoint.sh"]

# ── 2. server: backend runtime image — workspace + generated assets ─────────
# Carries source + node_modules + the generated runtime assets (app-runtime,
# share-runtime, route manifest), so the SAME image can run the Hono web
# server (tsx), the agent, the tsx workers, and the migrator — selected by the
# compose `command:` per service. Defaults to the web server. There is no
# compile step: server/web runs raw TypeScript under tsx, like server/api and
# every worker always have.
FROM deps AS server
ENV NODE_ENV=production
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
COPY infra/updater/updater.sh /app/release/updater.sh
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

# The owner-UI (client) image moved to the jackdaw repo at the split
# (2026-08-13): https://github.com/crossworks-engineering/jackdaw
