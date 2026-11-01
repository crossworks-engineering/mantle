# titanwest/mantle-sandbox: the batteries-included CLI-sandbox base image.
#
# Why this exists: plain ubuntu:24.04 ships with no python3, no node, no git,
# so every fresh sandbox paid minutes of apt before doing anything. This image
# front-loads the toolchains a coding sandbox uses, so `sandbox_create` to the
# first useful command is seconds, and first builds work with no network.
#
# v4 (2026-11): every language is on by default, each with a short kit chosen
# by its job in Mantle (plan "Agents that build apps", sections 4 and 4.1):
#   - Node 26 + npm + pnpm, and Bun.
#   - Python 3.12 (distro) with a global venv at /opt/venv, first on PATH.
#   - Go (latest stable) with gofmt, go vet and staticcheck. For sandbox jobs
#     and CLI tools.
#   - Rust (rustup, minimal profile) with rustfmt, clippy, the
#     wasm32-unknown-unknown target, wasm-pack, wasm-bindgen and wasm-opt. For
#     WebAssembly in mini apps, and fast CLIs.
#   - SQLite in every language, plus the sqlite3 and duckdb command lines.
#   - claude-code (`claude mcp serve` needs no key), docker CLI only (no
#     daemon), git, build-essential, ripgrep, jq and the everyday tools.
# What is installed is listed, machine-readable, in /etc/mantle/sandbox-kit.json
# (written at the end of this build from the installed versions), and
# `sandbox-smoke` proves SQLite and a first build in every language, online or
# with the network off.
#
# Reproducible by construction:
#   - base images pinned by digest; apt from a dated snapshot.ubuntu.com
#     snapshot (taken off again at the end, so a sandbox's own apt is live),
#     except ca-certificates (needed to reach the snapshot) and the docker
#     step, both from the live archives, signature-checked; docker-ce-cli
#     pinned to a version, and only Docker's one key (by fingerprint) trusted;
#   - every downloaded binary checked against a pinned sha256;
#   - every library from a lockfile with hashes: kit/python/requirements.lock
#     (pip --require-hashes), kit/node/package-lock.json (npm ci, install
#     scripts run with no network), kit/go/go.sum, kit/rust/Cargo.lock (cargo
#     fetch --locked);
#   - the Rust toolchain: rustup checks each component against the release
#     manifest, and verify-rust-manifest.py proves those are the hashes of the
#     manifest pinned here (RUST_CHANNEL_SHA256);
#   - duckdb's sqlite and excel extensions are checked by duckdb's own
#     signature check, not pinned here.
# How to bump a version, regenerate a lock and build: infra/sandbox-image/README.md.
#
# Boxes pull by the pinned tag (SANDBOX_DEFAULT_IMAGE), so an image update is
# an explicit env change, never a silent drift. Bump TAG (this directory) on
# every content change; .github/workflows/sandbox-image.yml builds, smoke-tests
# and pushes it.

ARG NODE_IMAGE=node:26.13.0-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

FROM ${NODE_IMAGE} AS node

# The Node kit from its lock (integrity-checked), in a stage of its own so the
# final image gets it as one layer. Install scripts do not run in `npm ci`
# (which has the network); the three the kit has (claude-code links its
# locked platform binary; esbuild, pnpm) run next with no network at all, so
# they can only use what the lock put there.
FROM node AS nodekit
COPY kit/node /kit
RUN cd /kit && npm ci --no-audit --no-fund --ignore-scripts
RUN --network=none cd /kit && npm rebuild --no-audit --no-fund @anthropic-ai/claude-code esbuild pnpm
# npm's cache, holding the kit's libraries and test runner (not the CLI-only
# tools: claude-code, pnpm, biome), from the same lock: what `npm install
# --offline --before=<kit date> <kit package>` installs from in a project
# with no network. npm-cache-kit.mjs adds each package's registry metadata,
# checks every cached package against the lock, writes the kit date (with
# --before set to it npm resolves to the lock's versions), and proves that an
# offline install of every kit library gives exactly the lock's packages.
COPY npm-cache-kit.mjs /npm-cache-kit.mjs
RUN mkdir /libs && cp /kit/package.json /kit/package-lock.json /libs/ && cd /libs \
    && node -e 'const fs = require("fs"); const p = JSON.parse(fs.readFileSync("package.json")); \
         for (const k of ["@anthropic-ai/claude-code", "pnpm", "@biomejs/biome"]) delete p.dependencies[k]; \
         fs.writeFileSync("package.json", JSON.stringify(p, null, 2))' \
    && npm install --no-audit --no-fund --ignore-scripts --cache /npm-cache \
    && node /npm-cache-kit.mjs /npm-cache /npm-before /kit/package-lock.json \
    && cd / && rm -rf /libs /npm-cache/_logs

FROM ${UBUNTU_IMAGE}

ARG TARGETARCH
ARG APT_SNAPSHOT=20261101T000000Z
ARG DOCKER_CLI_VERSION=5:29.9.2-1~ubuntu.24.04~noble
# The fingerprint of Docker's apt signing key (public, not a secret).
ARG DOCKER_REPO_KEY=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    GOPATH=/opt/go \
    GOTOOLCHAIN=local \
    GOTELEMETRY=off \
    GOFLAGS=-modcacherw \
    PATH=/opt/venv/bin:/opt/cargo/bin:/usr/local/go/bin:/opt/go/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Base toolchain, apt from the dated snapshot, caches purged. The snapshot
# service is HTTPS-only and the base image has no CA bundle, so ca-certificates
# comes first from the live archive (apt checks every index by its signature
# either way).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && echo "APT::Snapshot \"${APT_SNAPSHOT}\";" > /etc/apt/apt.conf.d/50mantle-snapshot \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
    ca-certificates curl wget gnupg git jq ripgrep unzip zip xz-utils vim nano tmux less \
    build-essential pkg-config cmake sqlite3 openssh-client \
    python3 python3-pip python3-venv \
    && rm /etc/apt/apt.conf.d/50mantle-snapshot \
    && rm -rf /var/lib/apt/lists/*

# docker CLI only (no daemon): Docker's apt repo, the CLI pinned to one
# version. The download must hold exactly one key, Docker's (by fingerprint),
# and only that key is exported into the keyring apt trusts.
RUN install -m 0755 -d /etc/apt/keyrings \
    && g=$(mktemp -d) \
    && curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$g/docker.asc" \
    && keys=$(gpg --show-keys --with-colons "$g/docker.asc" | awk -F: '/^pub/ { n++ } END { print n + 0 }') \
    && fpr=$(gpg --show-keys --with-colons "$g/docker.asc" | awk -F: '/^fpr/ { print $10; exit }') \
    && [ "$keys" = 1 ] && [ "$fpr" = "$DOCKER_REPO_KEY" ] || { echo "docker repo key: $keys keys, first $fpr, expected exactly $DOCKER_REPO_KEY" >&2; exit 1; } \
    && gpg --batch --homedir "$g" --import "$g/docker.asc" \
    && gpg --batch --homedir "$g" --export "$DOCKER_REPO_KEY" > /etc/apt/keyrings/docker.gpg \
    && rm -rf "$g" \
    && echo "deb [signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends "docker-ce-cli=${DOCKER_CLI_VERSION}" \
    && rm -rf /var/lib/apt/lists/*

# The kit definitions and locks (also read by the manifest at the end).
COPY kit /opt/mantle-kit

# Python: the global venv, every package from the hashed lock, wheels only.
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --require-hashes --only-binary=:all: \
    -r /opt/mantle-kit/python/requirements.lock \
    && /opt/venv/bin/pip check

# Node + npm from the official image (its binaries need only glibc).
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node -v && npm -v

# The Node kit (built in the nodekit stage above). `require` finds a kit
# library from any directory (NODE_PATH); an ESM project installs the ones it
# imports into its own node_modules with `npm install --offline
# --before=<kit date>` (/opt/mantle-kit/node/npm-before), from the cache. The
# kit's tools are linked into /usr/local/bin, so `tsc`, `npx tsc` and the rest
# all find the pinned ones offline; `npm i -g --force <tool>` replaces one.
# Claude Code does not update itself: the image is the pin.
COPY --from=nodekit /kit/node_modules /opt/mantle-kit/node/node_modules
COPY --from=nodekit /npm-cache /root/.npm
COPY --from=nodekit /npm-before /opt/mantle-kit/node/npm-before
RUN for b in pnpm pnpx claude biome esbuild tsc vitest; do \
      ln -s "/opt/mantle-kit/node/node_modules/.bin/$b" "/usr/local/bin/$b"; \
    done \
    && pnpm -v && claude --version && tsc -v && esbuild --version && biome --version && vitest --version
ENV NODE_PATH=/opt/mantle-kit/node/node_modules:/usr/local/lib/node_modules \
    DISABLE_AUTOUPDATER=1

# Bun (x64: the baseline build, which needs no AVX2).
ARG BUN_VERSION=1.4.4
ARG BUN_SHA256_AMD64=e0446eb55995772eb9894bebae9a6be368d985a8b9271ee124486f9946eedd76
ARG BUN_SHA256_ARM64=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
RUN case "$TARGETARCH" in \
      amd64) a=x64-baseline; sum=$BUN_SHA256_AMD64 ;; \
      arm64) a=aarch64; sum=$BUN_SHA256_ARM64 ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && d=$(mktemp -d) && cd "$d" \
    && curl -fsSL -o bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${a}.zip" \
    && echo "$sum  bun.zip" | sha256sum -c - \
    && unzip -q bun.zip \
    && install -m 0755 "bun-linux-${a}/bun" /usr/local/bin/bun \
    && ln -s bun /usr/local/bin/bunx \
    && cd / && rm -rf "$d" && bun --version

# Go, with the kit pre-fetched into the module cache and staticcheck built
# from the kit's go.mod tool line (both checked against kit/go/go.sum, which
# no step may change: it is compared with the committed copy after). The tidy
# in a copy WITHOUT go.sum asks the checksum database for every module (so its
# lookups and tiles land in the cache, for offline use), and every hash it
# gets must be one the committed go.sum pins. Only the module zips stay (go
# extracts one on first use, offline): the extracted copies doubled the size.
ARG GO_VERSION=1.27.3
ARG GO_SHA256_AMD64=65efbc80fdc1fa2cd2631cad5b481777a68e8725f34e89f50fc6ac714e379b40
ARG GO_SHA256_ARM64=a06e99309dbcbdca1a8ccd2282c3ee146e55930886e26b4f1193269587165f49
RUN case "$TARGETARCH" in \
      amd64) sum=$GO_SHA256_AMD64 ;; arm64) sum=$GO_SHA256_ARM64 ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-${TARGETARCH}.tar.gz" \
    && echo "$sum  /tmp/go.tgz" | sha256sum -c - \
    && tar -C /usr/local -xzf /tmp/go.tgz && rm /tmp/go.tgz \
    && cd /opt/mantle-kit/go \
    && t=$(mktemp -d) && cp go.mod go.sum kit.go "$t/" \
    && go mod download all \
    && go mod verify \
    && go install tool \
    && cmp go.sum "$t/go.sum" \
    && (cd "$t" && rm go.sum && go mod tidy && sort go.sum > new && sort /opt/mantle-kit/go/go.sum > pinned \
        && extra=$(comm -13 pinned new) && [ -z "$extra" ] || { echo "go.sum lines not in kit/go/go.sum: $extra" >&2; exit 1; }) \
    && rm -rf "$t" \
    && go clean -cache \
    && find /opt/go/pkg/mod -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} + \
    && go version && staticcheck -version
# The module cache is the first proxy: a kit module resolves from it with no
# network, and its checksum lookups come from the cache too, so go.sum checks
# still run offline. A module outside the kit falls through to the public
# proxy and the public checksum database.
ENV GOPROXY=file:///opt/go/pkg/mod/cache/download,https://proxy.golang.org,direct

# Rust: rustup (checksum-pinned) installs an exact toolchain, minimal profile,
# proven against the pinned release manifest (verify-rust-manifest.py).
COPY verify-rust-manifest.py /opt/mantle-kit/verify-rust-manifest.py
ARG RUSTUP_VERSION=1.29.2
ARG RUSTUP_SHA256_AMD64=5be191e8c70a5007074254cb74d78dbfdd25cd5a61c27de7b8e5410122ec24f4
ARG RUSTUP_SHA256_ARM64=a9c168dbea81a84671c6b7a5c1795cb0eb699020110d107ddfca427bd797e697
ARG RUST_VERSION=1.99.1
ARG RUST_CHANNEL_SHA256=fb152be80975c194aa5fc684b2aec3a6e14e2b855efe2faa4e5f8ae6e590f463
RUN case "$TARGETARCH" in \
      amd64) t=x86_64-unknown-linux-gnu; sum=$RUSTUP_SHA256_AMD64 ;; \
      arm64) t=aarch64-unknown-linux-gnu; sum=$RUSTUP_SHA256_ARM64 ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${t}/rustup-init" \
    && echo "$sum  /tmp/rustup-init" | sha256sum -c - \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --no-modify-path --profile minimal \
    --default-toolchain "$RUST_VERSION" --component rustfmt,clippy --target wasm32-unknown-unknown \
    && rm /tmp/rustup-init \
    && curl -fsSL -o /tmp/channel.toml "https://static.rust-lang.org/dist/channel-rust-${RUST_VERSION}.toml" \
    && echo "$RUST_CHANNEL_SHA256  /tmp/channel.toml" | sha256sum -c - \
    && /usr/bin/python3 -I /opt/mantle-kit/verify-rust-manifest.py /tmp/channel.toml \
       "$RUSTUP_HOME/toolchains/${RUST_VERSION}-${t}/lib/rustlib" \
    && rm /tmp/channel.toml \
    && rustc -V && cargo -V

# The WebAssembly tools as checksum-pinned release binaries: wasm-pack finds
# wasm-bindgen (the CLI, same version as the kit's crate) and wasm-opt on PATH,
# so `wasm-pack build` needs no download.
ARG WASM_PACK_VERSION=0.15.1
ARG WASM_PACK_SHA256_AMD64=410101009739b9d01c7d5affaaad6e9c9a24b4cba6791a4805db8e89b9bf7af2
ARG WASM_PACK_SHA256_ARM64=7004853c7925ae1984033b5f25866ec604bbc921ef956d5e6c5595bc5af6d30c
ARG WASM_BINDGEN_VERSION=0.2.130
ARG WASM_BINDGEN_SHA256_AMD64=9687f3bb551b9f66f37ed32a40d7913a00f7962db653054e56857bc306c3227f
ARG WASM_BINDGEN_SHA256_ARM64=99ffc93ce80081b91632e2b539b782821a8f3439ab0fddc645287462b2f55d3d
ARG BINARYEN_VERSION=133
ARG BINARYEN_SHA256_AMD64=2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489
ARG BINARYEN_SHA256_ARM64=89c07ea56faf38d0fbecf36ca8ec0721756716185f265b568e133d427f299bf8
RUN case "$TARGETARCH" in \
      amd64) m=x86_64; wp=$WASM_PACK_SHA256_AMD64; wb=$WASM_BINDGEN_SHA256_AMD64; by=$BINARYEN_SHA256_AMD64 ;; \
      arm64) m=aarch64; wp=$WASM_PACK_SHA256_ARM64; wb=$WASM_BINDGEN_SHA256_ARM64; by=$BINARYEN_SHA256_ARM64 ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && d=$(mktemp -d) && cd "$d" \
    && curl -fsSL -o wp.tgz "https://github.com/wasm-bindgen/wasm-pack/releases/download/v${WASM_PACK_VERSION}/wasm-pack-v${WASM_PACK_VERSION}-${m}-unknown-linux-musl.tar.gz" \
    && curl -fsSL -o wb.tgz "https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${WASM_BINDGEN_VERSION}/wasm-bindgen-${WASM_BINDGEN_VERSION}-${m}-unknown-linux-musl.tar.gz" \
    && curl -fsSL -o by.tgz "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-${m}-linux.tar.gz" \
    && printf '%s  wp.tgz\n%s  wb.tgz\n%s  by.tgz\n' "$wp" "$wb" "$by" | sha256sum -c - \
    && tar -xzf wp.tgz && tar -xzf wb.tgz && tar -xzf by.tgz \
    && install -m 0755 "wasm-pack-v${WASM_PACK_VERSION}-${m}-unknown-linux-musl/wasm-pack" /usr/local/bin/wasm-pack \
    && install -m 0755 "wasm-bindgen-${WASM_BINDGEN_VERSION}-${m}-unknown-linux-musl/wasm-bindgen" /usr/local/bin/wasm-bindgen \
    && install -m 0755 "binaryen-version_${BINARYEN_VERSION}/bin/wasm-opt" /usr/local/bin/wasm-opt \
    && if [ -d "binaryen-version_${BINARYEN_VERSION}/lib" ]; then cp -a "binaryen-version_${BINARYEN_VERSION}/lib/." /usr/local/lib/ && ldconfig; fi \
    && cd / && rm -rf "$d" \
    && wasm-pack --version && wasm-bindgen --version && wasm-opt --version

# The Rust kit fetched (not built) into the registry cache, every crate checked
# against kit/rust/Cargo.lock. Only the .crate files stay (cargo unpacks one on
# first use, offline): the unpacked copies were 400 MB.
RUN cd /opt/mantle-kit/rust && cargo fetch --locked \
    && rm -rf "$CARGO_HOME/registry/src" \
    && du -sh "$CARGO_HOME/registry"

# duckdb CLI, with its sqlite and excel extensions installed (signed by
# DuckDB, checked on install) so it reads SQLite and Excel files offline.
ARG DUCKDB_VERSION=2.0.0
ARG DUCKDB_SHA256_AMD64=c6507206baf7793c6013dbd82368469a45f20dc0e17a6f92f204602f652ed2bc
ARG DUCKDB_SHA256_ARM64=859e1875d2a9515fbb4bf8871061437a14af82320da68c753f094c4b776348fe
RUN case "$TARGETARCH" in \
      amd64) sum=$DUCKDB_SHA256_AMD64 ;; arm64) sum=$DUCKDB_SHA256_ARM64 ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && d=$(mktemp -d) && cd "$d" \
    && curl -fsSL -o duckdb.tgz "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/duckdb-cli-linux-${TARGETARCH}.tar.gz" \
    && echo "$sum  duckdb.tgz" | sha256sum -c - \
    && tar -xzf duckdb.tgz \
    && install -m 0755 "$(find . -type f -name duckdb | head -1)" /usr/local/bin/duckdb \
    && cd / && rm -rf "$d" \
    && HOME=/root duckdb -c "INSTALL sqlite; INSTALL excel; LOAD sqlite; LOAD excel;" \
    && duckdb --version

# /files is a bind mount whose ownership sandboxd rewrites on stop/rm.
RUN git config --system safe.directory '*'

# The smoke test and the kit manifest (written from what is installed).
COPY sandbox-smoke.sh /usr/local/bin/sandbox-smoke
COPY kit-manifest.py /opt/mantle-kit/kit-manifest.py
RUN chmod 0755 /usr/local/bin/sandbox-smoke \
    && mkdir -p /etc/mantle \
    && python3 -I /opt/mantle-kit/kit-manifest.py > /etc/mantle/sandbox-kit.json \
    && python3 -I -c 'import json; json.load(open("/etc/mantle/sandbox-kit.json"))'

WORKDIR /files
CMD ["sleep", "infinity"]
