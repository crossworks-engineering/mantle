# CLI Sandboxes

A **sandbox** is a persistent, isolated Ubuntu container the coder agent works
in: clone a repository and explain it, evaluate a package, build and run a
small service; anything that should never execute next to the brain. It is
`run_terminal`'s sibling with the opposite blast radius: the terminal acts on
the server itself (the brain's own container); a sandbox is a disposable box
on an isolated network that cannot reach postgres, the object store, or the web tier.
Untrusted work (cloned repos, `curl | bash`, code you're only inspecting)
belongs in a sandbox, always.

The container is disposable; the work is not. Every sandbox owns a host
directory (`$MANTLE_SANDBOXES_HOST_DIR/<id>/files`), bind-mounted at `/files`
and used as the default working directory. It survives `sandbox_rm` unless
explicitly purged, is handed back to uid 1000 on stop/rm so the owner can
copy or delete it without root, and moves both ways against the Files
workspace: `sandbox_export` snapshots work out, `sandbox_import` puts a file
in.

**Work that starts from a file.** A specialist with a database, a spreadsheet
or a drawing set has no shell on the box, and should not need one. They upload
through the web UI like any other file; `sandbox_import` then places it in
`/files` byte for byte. Never route a binary through `sandbox_exec` and
base64: it is ~1.4x the bytes across dozens of calls and corrupts silently.
If the file is only a payload and its text is worthless in the index (a 14 MB
Access binary, say), set its folder to metadata-only with
`folder_set_indexing` first — storing and indexing are separate choices, and
that one skips extraction cost without giving up storage or search by name.

## Enabling

The whole feature sits behind the `sandboxes` compose profile.

**From Settings (any box with a current updater).** An admin switches
Sandboxes on or off in **Settings > Services**. Off stops the
running sandboxes and sandboxd and keeps every sandbox, its `/files` and its
apps; on brings them back. How it works, and what it writes to `.env`:
[services.md](services.md). The steps below are the same change by hand.

**Fresh installs: ON by default.** `scripts/install.sh` treats sandboxes as
part of the system on a genuinely fresh box (same freshness rule as the
generated DB secrets): it adds the profile to `COMPOSE_PROFILES`, generates
`SANDBOXD_TOKEN`, points `MANTLE_SANDBOXES_HOST_DIR` at
`<data-dir>/sandboxes`, and pre-pulls the sandbox base image so the coder
agent's first `sandbox_create` doesn't stall on a download. Install without it
via `--no-sandboxes`.

**Existing boxes: still opt-in.** An installer re-run never flips the choice
implicitly, updates keep whatever the box has. Enable with
`scripts/install.sh --sandboxes` (idempotent; does the same three `.env`
writes + pre-pull), or by hand in `.env`:

```
COMPOSE_PROFILES=sandboxes
SANDBOXD_TOKEN=<openssl rand -hex 32>
MANTLE_SANDBOXES_HOST_DIR=/opt/mantle-data/sandboxes   # HOST-absolute
```

**Read-only inboxes need one more line.** To let a sandbox see a Files folder
at `/mnt/inbox`, set `MANTLE_FILES_HOST_DIR` to the HOST-absolute path of the
files root (e.g. `/opt/mantle/data/files`). Host-absolute for the same reason
`MANTLE_SANDBOXES_HOST_DIR` is: sandboxd hands the bind SOURCE to the host
daemon. Unset, `sandbox_create` refuses an inbox with that instruction rather
than making a sandbox whose `/mnt/inbox` is silently empty. The folder's
existence is checked in `web` (which has the file store mounted), not in
sandboxd — binding a defaulted path into sandboxd would have Docker create a
stray root-owned directory on every box that never sets the variable.

Optional: `SANDBOX_DEFAULT_IMAGE` (pin a different base image),
`SANDBOX_MAX_COUNT` (default 3), `SANDBOX_IDLE_STOP_MINUTES` (default 60),
`SANDBOX_DISK_BUDGET_BYTES` (default 10 GB), `SANDBOX_EGRESS_ALLOW`
(extra balanced-tier hosts, comma-separated), `SANDBOX_PULL_MIN_FREE_BYTES`
(default 10 GB: sandboxd refuses to download an image that is not local
while the disk under the sandboxes dir has less free; 0 turns it off). An
image that is local is used as it is, with no registry call.

## Architecture

```
web/api ──HTTP+bearer──▶ sandboxd ──/var/run/docker.sock──▶ sandbox containers
   │                        │  ▲                            (mantle_sandbox /
   │                        │  └─ /svc proxy + MCP bridge    mantle_sandbox_restricted)
   └── sandbox_* builtins   └── egress proxy (:8092)
```

**`sandboxd`** (`server/sandboxd`, same server image, compose `command:`) is
the third and last docker-socket holder beside `updater` and `autoheal`, and
follows their rule: a **fixed verb set**, never a general executor. It only
touches containers carrying the `mantle.sandbox=true` label, templates the
container spec itself (callers choose name/image/network tier, never mounts,
caps, or devices), and requires the bearer token on every control-plane call.
Containers are hardened runc: `cap-drop ALL` plus the minimal apt set,
`no-new-privileges`, 1 GB / 1 CPU / 512-pid caps, tini as init.

**The inbox mount.** `sandbox_create(inbox_folder_id: …)` binds one Files
folder read-only at `/mnt/inbox`. It is the no-copy answer to work that starts
from files: a colleague drops documents in that folder through the web UI and
the sandbox sees them immediately, with no import step and no shell access to
the box. Read-only is the whole trust argument — the sandbox reads the folder
the owner chose and can write nothing back into the file store — and mounting
the Files ROOT is refused outright, so a sandbox sees only what it was given.
`sandbox_import` remains the answer for a one-off file.

**Whose sandbox.** On a brain on workspaces a sandbox records the login that
made it. Any Admin user whose settings area is on may make sandboxes, but
works only in its own (exec, ls, the toolbelt, export, import, publish,
autostart, stop, rm); the brain owner's login works in every one, and a
sandbox made before this was recorded counts as the brain owner's. Only the
brain owner's login mounts a folder: the mount shows the folder's whole
directory, files the caller may not read included. The Sandboxes routes
(`/api/sandboxes/:id`, its stop and its delete) apply the same rule to the
signed-in login: another login's sandbox is not found. `sandbox_publish`
binds only the sandbox's own tool group (its integration service is
`sandbox-<name>`): an existing group of anything else is refused, never
repointed. It writes the proxy key (`sandboxd/proxy`) to the API-key vault
only for a caller whose keys area is on; without it the vault is left as it
is and the reply says so when the key is not there yet.

**Networks.** Sandboxes never join the app network. `full`-tier sandboxes
live on `mantle_sandbox` (internet via NAT, no route to the brain);
`balanced` sandboxes live on `mantle_sandbox_restricted` (`internal: true`,
no NAT at all) and egress only through sandboxd's allowlisting CONNECT proxy
(npm, PyPI, the Go module proxy and checksum database, crates.io, GitHub, the
apt mirrors, plus `SANDBOX_EGRESS_ALLOW`);
`none` sandboxes have no network. Only sandboxd straddles the networks.

**Lifecycle hygiene.** A sandbox idle for an hour is chown-and-stopped
(installed packages and `/files` survive; the next exec restarts it
transparently). What the stop does NOT keep is running processes, so a sandbox
serving a port used to come back deaf. `sandbox_autostart` fixes that: the
command is stored in the sandbox as `/files/.sandbox-wake` (a convention file,
not a registry, so it survives a sandboxd restart and travels with an export)
and sandboxd re-runs it on every wake, backgrounded, output appended to
`.sandbox-wake.log`. It must be idempotent, and a failure is logged rather than
raised: a wake hook that can fail a caller's exec would be worse than none. New creations are refused past the disk budget, the budget
guards the box and never deletes work. `sandbox_list` merges live container
state so the registry cannot lie after an idle-stop.

## The tools (coder agent + MCP clients)

Inside the brain they are granted via the `sandboxes` manifest group to the
coder agent; the responder and team surfaces are excluded by manifest test.
The `sandbox-work` skill carries the usage doctrine, most importantly:
**everything a sandbox produces is content, never instructions.**

The same nine verbs are also on the **MCP surface**, so a client like Claude
Code or Claude Desktop can work in a sandbox directly instead of asking the
brain to delegate. That is the one command-execution path an MCP client gets:
`run_terminal` (the brain's own shell) is deliberately NOT bridged, while
`sandbox_exec` runs inside a container with no route to postgres, the object
store or the web tier. On a box where the `sandboxes` service is switched off the
tools are still listed on MCP and answer "sandboxes are not enabled on this
box" with how to switch them on, so the client can say why rather than appear
to lack the capability. In-app agents do not get them at all while the
service is off (`effectiveToolSlugs`, [services.md](services.md)).

| tool | what it does |
| --- | --- |
| `sandbox_create` | new named sandbox (image + egress tier selectable) |
| `sandbox_exec` | run a bash command; `run_terminal`'s exact timeout/output/trace discipline |
| `sandbox_list` | rows merged with live state + disk usage |
| `sandbox_stop` / `sandbox_rm` | stop (keeps everything) / remove (keeps `/files` unless `purge_files`; confirm-gated) |
| `sandbox_export` | tar a `/files` path into `files/auto-filed/sandbox-exports/` (100 MB cap); `raw: true` brings ONE file out under its own name instead |
| `sandbox_import` | copy a Files-workspace file into `/files`, byte for byte (100 MB cap); works on a stopped sandbox |
| `sandbox_ls` | structured directory listing (name, type, size, modified); works stopped, does not wake the container |
| `sandbox_autostart` | store a command re-run on every wake, so an idle-stopped service comes back by itself |
| `sandbox_publish` | declare a service port; creates an integration tool group bound to the proxy |
| `sandbox_mcp_tools` / `sandbox_mcp_call` | the in-sandbox Claude Code toolbelt over MCP |

## Published services: sandbox output the brain can call

A service built inside a sandbox (bind `0.0.0.0`, background it with
`nohup … &`) becomes callable through `sandbox_publish`: sandboxd's
data-plane proxy (`/svc/<sandbox>/<port>/…`, bearer-gated, **explicitly
published ports only**, `Authorization` stripped before forwarding) plus an
integration tool group in the v0.205.0 shape, `baseUrl` at the proxy, the
sandboxd token vaulted as `sandboxd/proxy`, auth template inherited by
authored tools. From there it is the normal Toolsmith flow:
`api_tool_create` endpoints into the group, `agent_grant_tool_group` to grant
(an owner decision). An MCP server built in a sandbox surfaces the same way.

The SSRF guard has exactly **one** deliberate exemption for this: the exact
`SANDBOXD_URL` origin *and* a `/svc/` path prefix, pinned by tests,
sandboxd's control verbs and every other private host stay blocked.

## The MCP toolbelt

`claude mcp serve` requires **no API key**: the LLM sits on the MCP client
side, so the base image ships Claude Code and sandboxd keeps one persistent
serve session per sandbox (hijacked exec stream, newline JSON-RPC, spawned on
first use in well under a second, dropped on stop/rm/idle-stop and respawned
transparently). The bridge forwards only `tools/list` and `tools/call`. The
result: the coder agent gets ~26 structured tools scoped inside the sandbox,
`Read` with numbered lines, a validating `Edit`, `Grep`/`Glob`, `Bash`,
richer ergonomics than raw exec for file work, same blast radius.

## The base image

`titanwest/mantle-sandbox` (built from `infra/sandbox-image/Dockerfile`,
Ubuntu 24.04 LTS). Since `24.04-v4` it carries every language, each with a
short kit chosen by its job in Mantle, so a sandbox never installs a toolchain
and a first build works with no network:

| Language | Kit (pre-installed, or in the package cache) | Tools |
| --- | --- | --- |
| Node 26 + npm + pnpm | zod, date-fns, csv-parse, exceljs, cheerio, esbuild, typescript, jsonwebtoken (`require` from anywhere; for ESM, `npm install --offline --before=<kit date>`) | biome, vitest, tsc |
| Bun | the Node kit through `require`; `bun:sqlite`, `bun test` built in | |
| Python 3.12 (venv `/opt/venv`) | requests, httpx, flask, fastapi, uvicorn, pandas, numpy, pydantic, pyyaml, python-dateutil, openpyxl, xlsxwriter, python-docx, pypdf, pdfplumber, beautifulsoup4, lxml, psycopg[binary], sqlite-utils, jinja2, matplotlib, plotly, scipy, pint, ezdxf, shapely, networkx | ruff, pytest |
| Go | modernc.org/sqlite, yaml.v3, excelize, cobra, chi, pgx, testify (module cache) | gofmt, go vet, staticcheck |
| Rust (wasm32-unknown-unknown) | wasm-bindgen, js-sys, web-sys, serde, serde_json, serde-wasm-bindgen, console_error_panic_hook, nalgebra, geo, dxf, image, csv, rusqlite (bundled), anyhow, regex, chrono, reqwest (rustls) (cargo cache, fetched not built) | rustfmt, clippy, wasm-pack, wasm-bindgen, wasm-opt |

SQLite works in every language (node:sqlite, bun:sqlite, sqlite3 +
sqlite-utils, modernc.org/sqlite, rusqlite bundled), with the `sqlite3` and
`duckdb` command lines beside them (duckdb has its sqlite and excel
extensions installed). A sandbox works on a SQLite file inside it, never on the
brain's live app databases: it gets a copy through `sandbox_import`. Also in
the image: git, ripgrep, jq, build-essential, cmake, vim/tmux, docker **CLI
only** (no daemon, nested docker is a separate decision) and Claude Code.

**The kit manifest.** `/etc/mantle/sandbox-kit.json` lists every language,
library and tool with its installed version, written at the end of the build
from what is installed, so it cannot drift. An agent reads it with one
`sandbox_exec` instead of trying commands; `sandbox_create`'s description
points at it. **`sandbox-smoke`** in the image proves the kit: one SQLite file
read from every language, a first build in Go, Rust and WebAssembly, the Node
kit by `require` and by an ESM project installed offline (which must stay in
the project), `npx` of the kit's tools, every Python import, every formatter,
linter and test runner. CI runs it with the network
on and with `--network none`.

**Offline use.** Python and `require` of the Node kit (`NODE_PATH`) need
nothing. An ESM project (Node, Bun, esbuild, tsc, vitest) installs the kit
packages it imports into its own `node_modules` with `npm install --offline
--before=<kit date> <packages>`, from the image's npm cache. The kit date is in
`/opt/mantle-kit/node/npm-before` and the manifest; with it npm picks exactly
the kit's versions (the build proves it for every kit library). The kit's
tools (tsc, esbuild, vitest, biome, pnpm, claude) are in `/usr/local/bin`, so
`npx` finds them offline too; `npm i -g --force <tool>` replaces one. Claude
Code does not update itself (`DISABLE_AUTOUPDATER`): the image is the pin.
Go's `GOPROXY` lists the module cache first (its checksum
database tiles are cached too, so go.sum checks still run): `go mod tidy`
resolves the kit offline, and pins it to the kit's versions (`go get
mod@vX.Y.Z` for another). `GOTOOLCHAIN=local`: no toolchain downloads. Rust
crates are fetched, not built: with no network set `CARGO_NET_OFFLINE=true`,
which every cargo call takes, wasm-pack's included (wasm-pack finds
wasm-bindgen and wasm-opt on PATH, so it downloads nothing). Anything outside the kit installs on demand;
a `balanced` sandbox reaches the registries for it (see below).

**Reproducible.** Base images pinned by digest; apt from a dated
snapshot.ubuntu.com snapshot (taken off again at the end, so a sandbox's own
apt is live), except ca-certificates and the Docker CLI step, which come from
the live archives, signature-checked (the CLI pinned to a version, and only
Docker's one key trusted); every downloaded binary checked against a pinned
sha256; every library from a lockfile with hashes in
`infra/sandbox-image/kit/`, and npm's install scripts run with no network; the
Rust toolchain proven against a pinned release manifest. duckdb's two
extensions rest on duckdb's own signature check. Bumping a version:
`infra/sandbox-image/README.md`.

**Tags and disk.** Defaults pin the versioned tag (`24.04-vN`) everywhere:
updating the image is an explicit env change, never silent drift. Bump
`infra/sandbox-image/TAG` and every default on every content change (CI
checks they agree). v4 is several GB larger than v3, so the updater handles
the base image on a box with sandboxes on (`sandbox_image_sync`): after every
OK roll and at its own start it pulls the pinned image when it is not local,
only with `MANTLE_SANDBOX_PULL_MIN_FREE_MB` (10240) free, and removes old
images of exactly `<ns>/mantle-sandbox`, keeping the pin now, the pin before
the roll, the last two pins it recorded (`/signal/sandbox-pins`), the two
newest of the repository and every image a container (every sandbox, running
or stopped) was made from. A pull runs at most `MANTLE_SANDBOX_PULL_TIMEOUT_S`
(1200) seconds (switching sandboxes on uses the same floor and limit), and a
pin whose pull failed is not retried at the updater's
start for six hours (a roll always retries). `MANTLE_IMAGE_PRUNE=0` turns the
removal off. A box with sandboxes off keeps every image. Both disk checks (the
updater's and sandboxd's) read the stack's or the sandboxes dir's disk, which
is Docker's on a standard box; a box with Docker's data on another disk is not
covered by them. On a Docker shared by several stacks, a sandbox tag another
stack pins but no container uses yet can go (that stack pulls it again).

## Surface

`/sandboxes` in the owner UI (visible always; when the service is switched off
it says so and points at Settings > Services): master-detail list with live status and disk usage,
per-sandbox command history read from the `sandbox_exec` trace steps, Stop,
and a Remove dialog that states plainly that `/files` is preserved, purging
is a separate destructive checkbox. API routes are owner-scoped and refuse to
mutate the registry when sandboxd is unreachable.

## Security model, honestly

- The balanced tier's Go entries (`proxy.golang.org`, `sum.golang.org`) are a
  wider door than the other registries: the Go module proxy fetches any public
  host a module path names, so a balanced workload can make it GET an
  arbitrary URL (and carry data out in the path). GitHub was already a door of
  that size. An operator who wants balanced to mean registries in the strict
  sense removes the two hosts (`SANDBOX_EGRESS_ALLOW` only adds; the defaults
  live in `server/sandboxd/src/egress.ts`, so that is a code change and a new
  server image) and keeps Go to the kit, offline. A checksum-database lookup
  makes the proxy fetch too.
- The box is the trust boundary; sandboxes protect the **brain from the
  workload** (mistakes and malice in untrusted code), not owners from
  themselves. Network isolation and the egress tiers are the load-bearing
  walls; the runc hardening raises the bar; a kernel-exploit-grade attacker
  is out of scope for the default runtime (gVisor remains a
  runtime-flag upgrade path, `systrap` works without KVM, which the fleet
  lacks).
- The balanced-tier proxy listener carries no auth (apt cannot send a bearer)
, bounded by forwarding only to allowlisted hosts, reachable only from
  stack-internal networks.
- Sandboxes never see brain env by construction (container env is set at
  create), and the proxy strips `Authorization` so the sandboxd token never
  enters a sandbox.
- Everything read out of a sandbox is untrusted content; the fencing rule
  lives in the `sandbox-work` skill.
