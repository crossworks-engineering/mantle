# titanwest/mantle-sandbox — the batteries-included CLI-sandbox base image.
#
# Why this exists: plain ubuntu:24.04 ships with NO python3, NO node, NO git —
# every fresh sandbox paid minutes of apt before doing anything (measured
# repeatedly in the M1–M3 local test runs). This image front-loads the
# toolchain a coding sandbox actually uses, so `sandbox_create` → first useful
# command is seconds, not minutes.
#
# Contents (Ubuntu 24.04 LTS base):
#   - Python 3.12 (distro-native) + pip/venv, with a global venv at /opt/venv
#     on PATH carrying the common libs (requests, httpx, flask, fastapi,
#     uvicorn, pandas, numpy) — PEP 668 makes bare pip installs error on
#     24.04, the venv sidesteps that and `pip install` inside it Just Works.
#   - Node 26, the stack's own line, copied from the official node:<ver>-slim
#     image (no curl | bash installer), + npm and pnpm (Node 26 no longer
#     bundles corepack, so pnpm comes from npm).
#   - @anthropic-ai/claude-code preinstalled — `claude mcp serve` needs no API
#     key (the LLM sits client-side), so the agent-in-the-box MCP bridge can
#     start instantly. Refreshed on every image rebuild.
#   - docker CLI ONLY (docker-ce-cli): no daemon in the sandbox — nested
#     Docker needs sysbox/privileged and is a separate, deliberate decision.
#     The CLI is here so `docker context`/compose files can at least be
#     inspected, and so a future daemon decision needs no image change.
#   - Everyday tools: git, curl, wget, jq, ripgrep, sqlite3, build-essential,
#     zip/unzip, vim, nano, tmux, less, openssh-client.
#   - Global npm libs (jsonwebtoken) require-able from ANY directory via
#     NODE_PATH — sandbox scripts shouldn't need an npm init to use them.
#   - `git config --system safe.directory '*'`: /files is a bind mount whose
#     ownership legitimately changes (sandboxd chowns it to uid 1000 on
#     stop/rm), which otherwise trips git's dubious-ownership refusal.
#
# Build + push (workstation; titanwest push is pre-authorized):
#   docker build --pull -t titanwest/mantle-sandbox:24.04-v3 -t titanwest/mantle-sandbox:latest infra/sandbox-image
#   docker push titanwest/mantle-sandbox:24.04-v3 && docker push titanwest/mantle-sandbox:latest
# Bump the -vN tag on every content change; boxes pull by the pinned tag
# (SANDBOX_DEFAULT_IMAGE), so an image update is an explicit env change,
# never a silent drift.

# Node comes from the official image, pinned to a patched release: bump it
# with every Node security release (v3: 26.12.1, the October 2026 fixes).
FROM node:26.12.1-slim AS node

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

# Base toolchain + apt-sourced runtimes in one layer, caches purged.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates curl wget gnupg git jq ripgrep unzip zip vim nano tmux less \
    build-essential pkg-config sqlite3 openssh-client \
    python3 python3-pip python3-venv \
    # docker CLI only (no daemon) via Docker's apt repo
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Global python venv with the common libs, first on PATH.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir \
    requests httpx flask fastapi "uvicorn[standard]" pandas numpy

# Node + npm from the official image (its binaries need only glibc, which
# Ubuntu 24.04 has).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node -v && npm -v

# pnpm from npm (Node 26 no longer bundles corepack); Claude Code for the
# keyless MCP toolbelt; common node libs installed globally and made
# require-able everywhere via NODE_PATH.
RUN npm install -g pnpm @anthropic-ai/claude-code jsonwebtoken \
    && npm cache clean --force
ENV NODE_PATH=/usr/local/lib/node_modules

# /files is a bind mount whose ownership sandboxd rewrites on stop/rm.
RUN git config --system safe.directory '*'

WORKDIR /files
CMD ["sleep", "infinity"]
