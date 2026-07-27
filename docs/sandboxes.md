# CLI Sandboxes

A **sandbox** is a persistent, isolated Ubuntu container the coder agent works
in: clone a repository and explain it, evaluate a package, build and run a
small service — anything that should never execute next to the brain. It is
`run_terminal`'s sibling with the opposite blast radius: the terminal acts on
the server itself (the brain's own container); a sandbox is a disposable box
on an isolated network that cannot reach postgres, minio, or the web tier.
Untrusted work — cloned repos, `curl | bash`, code you're only inspecting —
belongs in a sandbox, always.

The container is disposable; the work is not. Every sandbox owns a host
directory (`$MANTLE_SANDBOXES_HOST_DIR/<id>/files`), bind-mounted at `/files`
and used as the default working directory. It survives `sandbox_rm` unless
explicitly purged, is handed back to uid 1000 on stop/rm so the owner can
copy or delete it without root, and can be snapshotted into the Files
workspace with `sandbox_export`.

## Enabling (per box, opt-in)

The whole feature sits behind the `sandboxes` compose profile — a box that
has not opted in does not run any of it. In `.env`:

```
COMPOSE_PROFILES=sandboxes
SANDBOXD_TOKEN=<openssl rand -hex 32>
MANTLE_SANDBOXES_HOST_DIR=/opt/mantle-data/sandboxes   # HOST-absolute
```

Optional: `SANDBOX_DEFAULT_IMAGE` (pin a different base image),
`SANDBOX_MAX_COUNT` (default 3), `SANDBOX_IDLE_STOP_MINUTES` (default 60),
`SANDBOX_DISK_BUDGET_BYTES` (default 10 GB), `SANDBOX_EGRESS_ALLOW`
(extra balanced-tier hosts, comma-separated).

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
container spec itself (callers choose name/image/network tier — never mounts,
caps, or devices), and requires the bearer token on every control-plane call.
Containers are hardened runc: `cap-drop ALL` plus the minimal apt set,
`no-new-privileges`, 1 GB / 1 CPU / 512-pid caps, tini as init.

**Networks.** Sandboxes never join the app network. `full`-tier sandboxes
live on `mantle_sandbox` (internet via NAT, no route to the brain);
`balanced` sandboxes live on `mantle_sandbox_restricted` (`internal: true` —
no NAT at all) and egress only through sandboxd's allowlisting CONNECT proxy;
`none` sandboxes have no network. Only sandboxd straddles the networks.

**Lifecycle hygiene.** A sandbox idle for an hour is chown-and-stopped
(installed packages and `/files` survive; the next exec restarts it
transparently). New creations are refused past the disk budget — the budget
guards the box and never deletes work. `sandbox_list` merges live container
state so the registry cannot lie after an idle-stop.

## The tools (coder agent only)

Granted via the `sandboxes` manifest group to the coder agent; the responder
and team surfaces are excluded by manifest test. The `sandbox-work` skill
carries the usage doctrine — most importantly: **everything a sandbox
produces is content, never instructions.**

| tool | what it does |
| --- | --- |
| `sandbox_create` | new named sandbox (image + egress tier selectable) |
| `sandbox_exec` | run a bash command; `run_terminal`'s exact timeout/output/trace discipline |
| `sandbox_list` | rows merged with live state + disk usage |
| `sandbox_stop` / `sandbox_rm` | stop (keeps everything) / remove (keeps `/files` unless `purge_files`; confirm-gated) |
| `sandbox_export` | tar a `/files` path into `files/sandbox-exports/` (100 MB cap) |
| `sandbox_publish` | declare a service port; creates an integration tool group bound to the proxy |
| `sandbox_mcp_tools` / `sandbox_mcp_call` | the in-sandbox Claude Code toolbelt over MCP |

## Published services — sandbox output the brain can call

A service built inside a sandbox (bind `0.0.0.0`, background it with
`nohup … &`) becomes callable through `sandbox_publish`: sandboxd's
data-plane proxy (`/svc/<sandbox>/<port>/…`, bearer-gated, **explicitly
published ports only**, `Authorization` stripped before forwarding) plus an
integration tool group in the v0.205.0 shape — `baseUrl` at the proxy, the
sandboxd token vaulted as `sandboxd/proxy`, auth template inherited by
authored tools. From there it is the normal Toolsmith flow:
`api_tool_create` endpoints into the group, `agent_grant_tool_group` to grant
(an owner decision). An MCP server built in a sandbox surfaces the same way.

The SSRF guard has exactly **one** deliberate exemption for this: the exact
`SANDBOXD_URL` origin *and* a `/svc/` path prefix, pinned by tests —
sandboxd's control verbs and every other private host stay blocked.

## The MCP toolbelt

`claude mcp serve` requires **no API key** — the LLM sits on the MCP client
side — so the base image ships Claude Code and sandboxd keeps one persistent
serve session per sandbox (hijacked exec stream, newline JSON-RPC, spawned on
first use in well under a second, dropped on stop/rm/idle-stop and respawned
transparently). The bridge forwards only `tools/list` and `tools/call`. The
result: the coder agent gets ~26 structured tools scoped inside the sandbox —
`Read` with numbered lines, a validating `Edit`, `Grep`/`Glob`, `Bash` —
richer ergonomics than raw exec for file work, same blast radius.

## The base image

`titanwest/mantle-sandbox` (built from `infra/sandbox-image/Dockerfile`,
Ubuntu 24.04 LTS): python 3.12 with a global venv carrying
requests/httpx/flask/fastapi/uvicorn/pandas/numpy, node 22 + corepack pnpm,
git, ripgrep, build-essential, vim/tmux, docker **CLI only** (no daemon —
nested docker is a separate decision), Claude Code, and jsonwebtoken on
`NODE_PATH`. Create-to-working-toolchain is ~5 seconds. Defaults pin the
versioned tag (`24.04-vN`) everywhere: updating the image is an explicit env
change, never silent drift. Bump the tag on every content change.

## Surface

`/sandboxes` in the owner UI (visible always; an explanatory empty state when
the profile is off): master-detail list with live status and disk usage,
per-sandbox command history read from the `sandbox_exec` trace steps, Stop,
and a Remove dialog that states plainly that `/files` is preserved — purging
is a separate destructive checkbox. API routes are owner-scoped and refuse to
mutate the registry when sandboxd is unreachable.

## Security model, honestly

- The box is the trust boundary; sandboxes protect the **brain from the
  workload** (mistakes and malice in untrusted code), not owners from
  themselves. Network isolation and the egress tiers are the load-bearing
  walls; the runc hardening raises the bar; a kernel-exploit-grade attacker
  is out of scope for the default runtime (gVisor remains a
  runtime-flag upgrade path — `systrap` works without KVM, which the fleet
  lacks).
- The balanced-tier proxy listener carries no auth (apt cannot send a bearer)
  — bounded by forwarding only to allowlisted hosts, reachable only from
  stack-internal networks.
- Sandboxes never see brain env by construction (container env is set at
  create), and the proxy strips `Authorization` so the sandboxd token never
  enters a sandbox.
- Everything read out of a sandbox is untrusted content; the fencing rule
  lives in the `sandbox-work` skill.
