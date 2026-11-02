# The sandbox base image

`titanwest/mantle-sandbox:<TAG>`, the image every `sandbox_create` starts from
unless a caller names another. What it carries and why: the header of
[Dockerfile](Dockerfile) and [docs/sandboxes.md](../../docs/sandboxes.md), "The
base image". Inside a sandbox the installed list with versions is
`/etc/mantle/sandbox-kit.json`, and `sandbox-smoke` proves it.

| File | What it is |
| --- | --- |
| `TAG` | the image tag (`TAG=24.04-vN`); every default in the repo pins it |
| `Dockerfile` | the build; every downloaded binary has a pinned sha256 |
| `kit/python/requirements.in` | the Python kit, exact versions |
| `kit/python/requirements.lock` | generated from it, with hashes; the image installs this |
| `kit/node/package.json` + `package-lock.json` | the Node kit; the lock holds every package's integrity hash |
| `kit/go/go.mod` + `go.sum` | the Go kit, pre-fetched into the module cache; staticcheck is its `tool` line |
| `kit/rust/Cargo.toml` + `Cargo.lock` | the Rust kit, fetched (not built) into the cargo cache |
| `kit-manifest.py` | writes `/etc/mantle/sandbox-kit.json` from what is installed |
| `verify-rust-manifest.py` | proves rustup's components carry the pinned release manifest's hashes |
| `sandbox-smoke.sh` | `/usr/local/bin/sandbox-smoke`: SQLite and a first build in every language |

## Changing the image

Any change to what the image holds is a new tag. Never reuse one: boxes pull
by tag, and a box that has the old content under the same tag never pulls the
new.

1. Edit the version (a `*_VERSION` / `*_SHA256_*` pair in the Dockerfile, a
   line in a kit file).
   - A binary's sha256 comes from its publisher: `go.dev/dl/?mode=json` for Go,
     the release's `SHASUMS256.txt` / `.sha256` / `.sha256sum` file (Bun,
     wasm-bindgen, binaryen, rustup), or the GitHub release asset's `digest`
     (duckdb, wasm-pack). Take both `amd64` and `arm64`.
   - Keep `WASM_BINDGEN_VERSION` equal to the `wasm-bindgen` crate in
     `kit/rust/Cargo.toml`: wasm-pack only uses a wasm-bindgen CLI on PATH that
     matches the crate a build resolves.
   - Moving `APT_SNAPSHOT` to a newer date takes the distro's security fixes.
   - A new `RUST_VERSION` needs its `RUST_CHANNEL_SHA256`:
     `https://static.rust-lang.org/dist/channel-rust-<version>.toml.sha256`.
2. Regenerate the lock you touched, in a throwaway container on the
   workstation (never Docker on a Mac):
   - Python: `uv pip compile --universal --generate-hashes --python-version 3.12 --no-header requirements.in -o requirements.lock`
     (in `python:3.12-slim` with `pip install uv`).
   - Node: delete `package-lock.json` first, then `npm install --package-lock-only --ignore-scripts`
     (in the Dockerfile's Node image). A lock refreshed in part keeps old transitive versions, and
     the build's offline proof (`npm-cache-kit.mjs`) then refuses it.
   - Go: `go mod tidy` (in `golang:<GO_VERSION>`).
   - Rust: `cargo generate-lockfile` (in `rust:<RUST_VERSION>`).
3. Bump `TAG`, and the default in every place that pins it (the
   `sandbox-image` workflow checks they agree): `server/sandboxd/src/main.ts`,
   `packages/tools/src/sandbox/lifecycle.ts`,
   `packages/tools/src/builtins-sandbox-write.test.ts`, `docker-compose.yml`,
   `scripts/install.sh`, `.env.example`.
4. Build and smoke-test on the workstation:

   ```sh
   docker build -t mantle-sandbox:test infra/sandbox-image
   docker run --rm mantle-sandbox:test sandbox-smoke
   docker run --rm --network none mantle-sandbox:test sandbox-smoke
   ```

   Both runs must end `0 failed`. Run it with a sandbox's limits too
   (`--memory 1g --cpus 1 --pids-limit 512`), the size a real sandbox has.
5. On main, `.github/workflows/sandbox-image.yml` builds both platforms
   natively, runs `sandbox-smoke` online and offline on each, pushes the image
   it tested as `<TAG>-amd64` / `<TAG>-arm64` (rewritten by each build; boxes
   never pull them), and then the multi-arch `<TAG>`. It refuses to overwrite
   a published `<TAG>` unless forced, stops when it cannot tell whether the tag
   exists, and fails a push that changes the image without a new `TAG`.

## Licences

The kits are chosen permissive (MIT, BSD, Apache-2.0, ISC, PSF, Unlicense,
Zlib, 0BSD, MIT-0, CC0, CDLA-Permissive-2.0, Unicode-3.0, HPND (Pillow), the
OpenSSL licence (aws-lc-sys)). Where a package offers a choice (jszip "MIT or
GPL-3.0", r-efi "MIT or Apache-2.0 or LGPL-2.1"), it is taken under MIT. The
exceptions, kept on purpose:

- **psycopg / psycopg-binary**: LGPL-3.0, used as an unmodified library, which
  the LGPL allows; asked for by name (Postgres from Python). Its bundled libpq
  is under the PostgreSQL licence.
- **lightningcss** (MPL-2.0, file-level copyleft), pulled in by vitest, and
  **certifi** (MPL-2.0), pulled in by requests: unmodified.
- **Bun** is MIT and links JavaScriptCore (LGPL-2.1), unmodified.
- **numpy / scipy wheels** bundle libgfortran (GPL-3.0 with the GCC runtime
  library exception, which covers this use).
- **hashicorp/golang-lru** (MPL-2.0) is in the Go module cache as a test-only
  dependency of modernc.org/libc; nothing built from the kit links it.
- **buffers** (an exceljs dependency) declares no licence in its package.json.
- **Claude Code** is under Anthropic's own terms (not open source). It is
  redistributed in this public image as v1 to v3 did; whether that is covered
  by its terms is for the owner to confirm.
