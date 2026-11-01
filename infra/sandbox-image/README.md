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
2. Regenerate the lock you touched, in a throwaway container on the
   workstation (never Docker on a Mac):
   - Python: `uv pip compile --universal --generate-hashes --python-version 3.12 --no-header requirements.in -o requirements.lock`
     (in `python:3.12-slim` with `pip install uv`).
   - Node: `npm install --package-lock-only --ignore-scripts` (in the Dockerfile's Node image).
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
   natively, runs `sandbox-smoke` online and offline on each, and pushes the
   tag (it refuses to overwrite one that exists unless forced).

## Licences

The kits are chosen permissive (MIT, BSD, Apache-2.0, ISC, PSF, Unlicense,
Zlib). The exceptions, kept on purpose:

- **psycopg / psycopg-binary**: LGPL-3.0, used as an unmodified library, which
  the LGPL allows; asked for by name (Postgres from Python). Its bundled libpq
  is under the PostgreSQL licence.
- **lightningcss** (MPL-2.0, file-level copyleft), pulled in by vitest, and
  **certifi** (MPL-2.0), pulled in by requests: unmodified.
- **Bun** is MIT and links JavaScriptCore (LGPL-2.1), unmodified.
- **Claude Code** (Anthropic's own terms) was in the image before v4.
