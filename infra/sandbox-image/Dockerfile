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
#   - Node 22 LTS (NodeSource) + npm, with corepack-managed pnpm activated.
#   - @anthropic-ai/claude-code preinstalled — `claude mcp serve` needs no API
#     key (the LLM sits client-side), so the agent-in-the-box MCP bridge can
#     start instantly. Refreshed on every image rebuild.
#   - docker CLI ONLY (docker-ce-cli): no daemon in the sandbox — nested
#     Docker needs sysbox/privileged and is a separate, deliberate decision.
#     The CLI is here so `docker context`/compose files can at least be
#     inspected, and so a future daemon decision needs no image change.
#   - Everyday tools: git, curl, wget, jq, ripgrep, sqlite3, build-essential,
#     zip/unzip, nano, less, openssh-client.
#   - `git config --system safe.directory '*'`: /files is a bind mount whose
#     ownership legitimately changes (sandboxd chowns it to uid 1000 on
#     stop/rm), which otherwise trips git's dubious-ownership refusal.
#
# Build + push (workstation; titanwest push is pre-authorized):
#   docker build -t titanwest/mantle-sandbox:24.04-v1 -t titanwest/mantle-sandbox:latest infra/sandbox-image
#   docker push titanwest/mantle-sandbox:24.04-v1 && docker push titanwest/mantle-sandbox:latest
# Bump the -vN tag on every content change; boxes pull by the pinned tag
# (SANDBOX_DEFAULT_IMAGE), so an image update is an explicit env change,
# never a silent drift.

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

# Base toolchain + apt-sourced runtimes in one layer, caches purged.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates curl wget gnupg git jq ripgrep unzip zip nano less \
    build-essential pkg-config sqlite3 openssh-client \
    python3 python3-pip python3-venv \
    # Node 22 LTS via NodeSource
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
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

# pnpm via corepack; Claude Code for the keyless MCP toolbelt.
RUN corepack enable && corepack prepare pnpm@latest --activate \
    && npm install -g @anthropic-ai/claude-code \
    && npm cache clean --force

# /files is a bind mount whose ownership sandboxd rewrites on stop/rm.
RUN git config --system safe.directory '*'

WORKDIR /files
CMD ["sleep", "infinity"]
