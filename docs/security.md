# Security & safety nets — an overview

> How a Mantle brain protects its data, what each external surface can and
> cannot reach, and the safety nets that keep an install honest over time.
> Written to be readable by a security reviewer during a corporate pilot; each
> section links to the deeper doc. The two surfaces external people actually
> touch — **Team Chat** and **shared Apps** — get their own detailed sections
> (§5, §6).

---

## 1. Posture in one page

- **Self-hosted, single-owner.** A brain runs on infrastructure you control.
  All state lives under `${MANTLE_DATA_DIR}` on that host (Postgres, MinIO
  files, per-app SQLite, backups). There is no vendor SaaS in the data path
  and no phone-home with content.
- **What leaves the box:** prompts + retrieved context sent to the **model
  providers you configure** (or nothing, with local models), outbound email
  you explicitly send, Telegram messages on a paired bot, and update checks
  (version metadata only). That's the list.
- **The brain is the trust boundary.** This is a deliberate design decision:
  everyone admitted to a brain (owner, admins, team members within their
  surface) is trusted to the level that surface grants. There are no in-brain
  tiered read ACLs — when different groups need different visibility, you
  deploy **separate brains**, one per boundary. Features are permissive
  *within* the boundary and strict *at* it.
- **Robustness over seamlessness.** Standing engineering rule: gates
  (approvals, allowlists, shown-once tokens) are not eroded for convenience,
  and integrity-adjacent changes get the slow, careful treatment.

## 2. Identity & credentials

| Credential | Who holds it | Scope | Revocation |
|---|---|---|---|
| Owner/admin login + session cookie | you and named admins | the whole app | change password; delete the admin user |
| **Team token** (8 chars, shown once, SHA-256 at rest) | a Contact you flagged as team member | the `/team` workspace (every ACTIVE share, read-only) + its Assistant, `/hub`, and team-mode `/s` shares — nothing else | flip the toggle or delete the contact — instant, mid-session |
| Share token (~128-bit CSPRNG in the URL) | anyone with the link | exactly one shared item (or one public app) | turn the share off |

Notes that matter to a reviewer:

- **Multi-admin** uses an actor/anchor split: every admin acts as themselves
  (auditable), the brain's data anchors to one owner. Revoking an admin =
  deleting their user.
- Team tokens are **hashed at rest**; the plaintext is shown once at mint.
  Token-entry endpoints return a **uniform 401** for wrong-vs-unknown tokens
  (no oracle) and are **rate-limited** per-IP (hardened client-IP derivation
  honouring `MANTLE_TRUSTED_PROXIES`, so the bucket can't be reset by spoofed
  headers) and per-brain.
- **Liveness on every request:** external surfaces re-check membership per
  request, not per session — revocation takes effect immediately.
- Cookies are signed; `secureCookies(req)` keeps auth working correctly on
  plain-HTTP LAN installs without weakening HTTPS ones.

## 3. The external surfaces — what each can reach

Everything an outside person can touch, in one table. "Write path" is the
complete list of ways that surface can change the brain.

| Surface | Auth | Reads | Write path | Audit |
|---|---|---|---|---|
| `/s/<token>` shared page/note/task/event/file | link token | that one item + its own embedded assets only | none | view count |
| `/s/<token>` **public app** | link token | the app's own SQLite, read-only | none (no brain tools, no DB writes) | app access log |
| `/s/<token>` **team app** | link token + team token | app SQLite + the app's *declared* tools (built-ins only) | app SQLite writes + declared tools | app access log, per member |
| `/team` **workspace** | team token | the owner's ACTIVE shares (team + public mode), rendered read-only through the `/s` presenters — the share stays the only content door | none | share view counts + access log |
| `/team/assistant` **Team Chat** | team token | brain knowledge via a read-only responder (email + journal excluded by default) | one wrapped tool that files a task for human review | access log + full per-turn traces |
| Telegram | explicit bot pairing | owner-level assistant (this is *your* channel, not a team one) | assistant tools per its grants | traces |
| MCP (Claude Desktop etc.) | SSH/exec into the container — operator-only today | owner-level tools | owner-level tools | traces |

Two structural points:

- **Public means self-contained.** A public link never reaches brain tools —
  there is no "safe slice" of a private brain to expose to anonymous visitors,
  so the answer is none (enforced by a hard server-side gate, not convention).
- **Identified beats anonymous.** Everything with real capability requires a
  team token that maps to a named Contact, and every action is logged against
  that name.

## 4. The assistant's guard rails

The AI itself is fenced the same way people are:

- **Capability = explicit grants.** An agent can only call tools in its
  granted tool groups; the persona's default grant carries a deny-set
  (no terminal, no page-delete, etc.). The whole agent→skill→tool graph is
  declared in one **system manifest**, drift-tested in CI, and live-checked on
  the box ([`system-integrity.md`](./system-integrity.md)).
- **Human approval gate.** Tools marked *requires confirmation* don't run —
  they queue under **Pending** until you approve or reject. Runtime-composed
  recipe tools live in a safe envelope with the same build→approve→re-ask
  loop.
- **Secrets are sealed.** The vault splits metadata (searchable, so the
  assistant can *find* a credential) from AES-256-GCM-encrypted values the
  agent never reads ([`secrets.md`](./secrets.md)).
- **Prompt-injection stance:** retrieved content is framed as data, not
  instructions (grounding skills), and — more importantly — the *blast radius*
  is bounded structurally: on external surfaces the worst an injected prompt
  can do is what that surface's write path allows (§5, §6).
- **Everything is traced.** Every turn and every tool call lands in `/traces`
  with steps, cost, and timing — the "show me exactly what happened" view.

## 5. Team Chat security (deep) — [`team-chat.md`](./team-chat.md)

The design assumption: a team member is *trusted to read the brain's
knowledge* but *never trusted to write*, and everything they do must be
attributable.

- **Read-only by construction.** The team responder's tool group is read-only
  brain-wide, with `export_node`, `recall_window`, and all delegation excluded
  — locked by a manifest drift-guard test, so a future manifest edit can't
  silently widen it.
- **Private corpus excluded by default.** Email and journal reads require an
  explicit owner opt-in (`teamPrivateReads`, default **off**), enforced at
  tool resolution independently of the group grant, behind a confirmation
  dialog that spells out the exposure.
- **One write path, provenance-stamped.** The single write tool files a
  review-queue task whose provenance (who, from which message, which
  attachments) is stamped **by the server, never from model arguments** — so
  the worst-case prompt-injection outcome is a *clearly team-labelled task in
  a human-reviewed queue*. Team requests never touch the agent
  tool-execution gate directly.
- **Member isolation.** Turn ids are minted server-side embedding the caller's
  contact id; the stream route rejects any id whose contact doesn't match the
  authenticated caller. A member cannot construct, replay, or tail another
  member's turn — and owner turns are unreachable from the team route
  entirely. Context assembly injects no owner persona notes, digests, or other
  members' threads.
- **No memory contamination.** Team conversations are not semantically indexed
  into the brain's memory corpus; the owner reads them via dedicated tools.
  Uploaded *files* do ingest — deliberately — carrying
  `source = 'team:<contactId>'` provenance forever.
- **Cost containment.** Per-contact rate limit + `TEAM_CHAT_DAILY_TURNS` daily
  cap (denials logged), so a leaked token is a bounded nuisance, not a wallet
  drain.
- **Accepted trade-offs, stated plainly:** (1) within the boundary, a member
  can surface anything the responder can read — including via injection in
  content; that's the coarse-permission model, and the enable switch says so.
  (2) Members see the same live status narration the owner sees — chosen
  transparency, documented, within the trust boundary.

## 6. Apps security (deep) — [`app-authoring-guide.md`](./app-authoring-guide.md)

Mini-apps are user-authored code, so they're treated as untrusted by the host
even when *you* wrote them:

- **Sealed sandbox.** Apps run in an opaque-origin iframe: no credentials, no
  same-origin access, no direct network. The only window to the host is a
  brokered postMessage bridge; all real work executes server-side.
- **Build-time allowlist.** The bundler rejects any import outside a short
  allowlist (React, the UI kit, icons, the host bridge) — no arbitrary npm, no
  supply-chain surface inside an app.
- **Capability is declared per app.** An app may call only the tool slugs
  explicitly set on it; the host refuses anything else at runtime. Secrets and
  API keys resolve server-side — the iframe never sees a key.
- **One database per app**, no path input — an app can only ever reach its own
  SQLite. `ATTACH`/`PRAGMA` are blocked. The assistant's cross-app access is
  opened read-only *at the engine level* (any write throws), so no crafted
  query can mutate app data.
- **Share modes bound external capability** (§3): public = own-data,
  read-only, zero brain tools; team = identified members, declared tools +
  writes, everything audited to the person on the app's **Activity** tab.
  Even team mode refuses non-builtin handlers — a shared app can never hand a
  visitor server-side HTTP or shell execution under the owner's account.
- **Durability is first-class.** App DBs run in WAL mode and are snapshotted
  into the standard backup via `VACUUM INTO` (consistent under load), with
  loud reporting when any DB can't be snapshotted.

## 7. Data protection & durability

- **Backups:** built-in scheduled `pg_dump` with rotation
  ([`backups.md`](./backups.md)); `db-dump.sh` also captures every per-app
  SQLite. Getting the folder offsite is deliberately the operator's job.
  Standing rule: dump before any live migration (enum changes aren't
  reversible).
- **Encryption:** secrets are AES-256-GCM at rest; team + asset tokens are
  hashed; disk/transport encryption is the host's TLS + volume story (Caddy
  auto-TLS on the standard deploy).
- **Restore reality:** disaster recovery = restore the dump + the data dir;
  documented and exercised (registry-pull deploys snapshot `.env` and DB
  before every roll).

## 8. Operational safety nets

The nets that catch drift and breakage before they become incidents:

- **System integrity checker** — the manifest-driven config graph is verified
  in CI (a dangling tool/skill fails the build) *and* live on the box
  (`/debug` → Integrity), so silent capability drift is surfaced, not
  accumulated.
- **Sanity check** — a read-only `/debug` tab that inspects
  provisioning-hidden breakage (missing buckets, workers, seeds) on any box.
- **Deploy discipline** — releases are pinned image tags pulled from the
  registry; preflight includes typecheck, the full test suite (~1.9k tests),
  and a production `next build`; prod rolls take a DB dump first.
- **Access logs + traces everywhere** external capability exists (app
  activity, team access log, per-turn traces with cost).
- **Rate limiting** on every anonymous/token entry point.
- **Update visibility** — the in-app updater surfaces new versions and the
  full per-release changelog (`/changelog`), so operators know exactly what a
  roll contains.

## 9. What a pilot reviewer should take away

1. External exposure is **opt-in, enumerable, and small** (§3's table is the
   complete list), with anonymous surfaces structurally incapable of reaching
   brain data.
2. External *people* are **named, tokenized, audited, and instantly
   revocable** — and their write ability is either zero or a human-reviewed
   queue.
3. The AI's capability is **declared, drift-tested, and gated** — not
   emergent.
4. The honest limits are the coarse-permission model (§1) and the residual
   risks of any LLM system (injection can steer *reads* within a surface's
   boundary; model providers see what's sent to them unless you run local
   models). Both have a clear mitigation: **brain per boundary**, and local
   models where content must not leave the site.
