# Unreleased — CLI Sandboxes (feat/cli-sandboxes)

> Rename this file to `<version>.md` when the release is cut.

**The feature.** Persistent, isolated Ubuntu containers the coder agent works
in — clone and explain repositories, evaluate packages, build and publish
small services — with the work surviving the container. Full doc:
[docs/sandboxes.md](../sandboxes.md). Everything is opt-in per box behind the
`sandboxes` compose profile.

**What ships (12 commits, d7835608..c7fb8d82):**

- **`sandboxd` supervisor** (`server/sandboxd`): the third docker-socket
  holder, fixed verb set, bearer auth, label-scoped, zero new dependencies
  (`node:http` over the socket, including the exec stream demux). Hardened
  runc containers, isolated networks, idle auto-stop, disk budget.
- **Persistence contract**: per-sandbox `/files` host dir survives removal,
  chowned back to uid 1000 from inside the container before stop/rm (found
  the hard way: root-written clones were owner-undeletable).
- **Nine `sandbox_*` builtins** granted to the coder agent via the new
  `sandboxes` tool group; responder/team exclusion is manifest-test-enforced;
  destructive verbs confirm-gated; exec mirrors `run_terminal`'s
  timeout/output/trace discipline. The new `sandbox-work` skill carries the
  doctrine (trust boundary, content-not-instructions fencing, egress choice).
- **Published services** (`sandbox_publish`): a service built in a sandbox
  becomes an integration tool group bound to sandboxd's data-plane proxy —
  published ports only, token stripped before forwarding, secret vaulted as
  `sandboxd/proxy`. The SSRF guard gains its one deliberate, doubly-bounded,
  test-pinned exemption (exact origin + `/svc/` prefix).
- **MCP toolbelt** (`sandbox_mcp_tools`/`_call`): one persistent keyless
  `claude mcp serve` per sandbox bridged over a hijacked exec stream —
  tools/list + tools/call only. ~26 structured tools (validating Edit,
  numbered Read, Grep/Glob, Bash); ~50 ms reused-session calls.
- **Three egress tiers**: `full` (isolated bridge, internet), `balanced`
  (internal network, no NAT — outbound only via sandboxd's allowlisting
  CONNECT proxy: registries, GitHub, apt mirrors; `SANDBOX_EGRESS_ALLOW`
  extends), `none` (offline).
- **Base image** `titanwest/mantle-sandbox:24.04-v2`
  (`infra/sandbox-image/Dockerfile`): python 3.12 + common libs, node 22 +
  pnpm, git, vim/tmux, docker CLI, Claude Code, jsonwebtoken. Create → full
  toolchain in ~5 s; pinned-tag defaults everywhere.
- **`/sandboxes` surface**: master-detail with live status, disk usage,
  per-sandbox command history from trace steps, Stop, and a Remove dialog
  that keeps `/files` unless explicitly purged.

**Migrations:** 0138 (`sandboxes` table), 0139 (`sandbox_network` +
`'balanced'`). **Compose:** `sandboxd` service (profile `sandboxes`),
`mantle_sandbox` + `mantle_sandbox_restricted` networks — the stack's first
explicit `networks:` keys. **Dockerfile:** `server/sandboxd` in the COPY
list.

**Verified on the workstation** (per Jason's directive: nothing touches dev
until complete): four tool-layer batteries through the real builtin handlers
against real Docker + a migrated throwaway Postgres (M1 15/15, M2 6/6, M3
7/7 incl. the `{"sum":42}` acceptance through vault→carve→proxy→service, M4
9/9), plus an 8/8 compose-profile demo from a server image built off this
branch. Full suite 2916 green throughout.

**Still open before/at release:** the live coder-agent conversation test
(needs a running brain — natural moment is enabling the profile on dev), and
the version stamp for this entry.
