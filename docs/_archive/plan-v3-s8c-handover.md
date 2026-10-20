# Plan v3.2 S8c: one Login type, Admin from scope (handover)

Plan v3.2 section 2.2 point 3: a strangler by package in four parts, one
merge per part. The spec's lines are in [../actors.md](../actors.md),
section 6 ("Who may do what") and section 15 ("Known limits"); this file
holds each part's detail and its handover.

## Part c1: server/web/lib/auth

The branch `feat/s8c-c1`, cut from main at 1967cf106 (v0.300.107). No
migration.

### CEO decisions (2026-10-20, before the build)

- `mantle_scope_admin_facts()` does not exist. No migration: adminFacts is
  one SQL round trip in the login's own scope that selects the existing
  functions (`mantle_scope_is_admin()`, and `mantle_scope_has_area(a)` for
  each area; `mantle_view_user` may EXECUTE both). S8b may fold it into
  one SQL function once membership decides the role.
- Byte-equal before S8b: `admin` = the scope's answer AND the row's legacy
  pair (role admin AND `adminMember`, already read by `loadLoginRow`);
  areas count only when `admin` is true. The role AND is named as a
  transition in one helper, one place (`loginAdminPair`).
- No scope open (sign out, change password, OAuth consent, anything
  getLoginOr401 serves on the system pool): the row's pair, and the area
  rule's areas when it holds.
- No `runtime-role.ts` edit is needed, and none was made.
- `loginRoleDecisionReads`: the brief's "1" was wrong; every pin only
  down from its measure (34, 50, 44).

### What changed

- **`server/web/lib/auth/login.ts` (new).** `type Login = { loginId,
  brainId, email, displayName, contactId, source, sessionEpoch, actor }`,
  readonly, no role and no kind. `adminFacts(login): Promise<{ admin,
  areas: ReadonlySet<ScopeArea> }>`:
  - in a scope for the login's own login: one statement,
    `select mantle_scope_is_admin() as admin, (array of the areas where
    mantle_scope_has_area(a), in SCOPE_AREAS order) as areas`;
  - with no scope open: the row's answer, and `loginAreas`
    (`mantle_login_areas`) when it holds;
  - both AND `loginAdminPair(login)`; areas only when `admin`;
  - a scope for another login (or for none) rejects;
  - memoized per request context (per Login object outside a request),
    keyed by login and by scoped or not; an error answers no (fix round 1
    keys it on the Login object and the scope object instead, below).
- **`server/web/lib/auth/session.ts`.**
  - `getLoginOr401` answers a `Login`. The legacy two-shape answer is the
    exported `AnyLogin` type (a transition adapter), reached through
    `legacyLogin(login)` (a WeakMap on the very object getLoginOr401
    answered; any other object throws) and `loginCaller()` (unchanged
    shape for the c2 handlers). The pipeline's `login` answer holds the
    Login; `publicLoginCaller()` still answers the legacy shape.
  - `loginAdminPair(login)`: the row's pair for a Login getLoginOr401
    answered (false for any other).
  - The resolved caller carries `loginId`, the admin's `contactId` and its
    `adminPair` (`adminLogin(row)`, the S8a helper, unchanged), so
    `resolvedLoginId` and the two picks of the login id are gone.
  - `SessionUser` and `MemberCaller` are marked transition adapters.
- **`server/web/lib/workspaces.ts`.** `WsCaller` loses `kind` (nothing
  read it); `workspaceCaller` and `loginHoldsArea` stop setting it.
  `server/web/app/api/access-keys/route.ts` stops passing it (one line).
- **Type tests.** `login-shape.test.ts`: `LOGIN_SHAPE_PIN` is `{ kind:
  false, role: false }`, and it also pins the Login's eight keys and that
  getLoginOr401 answers `login.ts`'s Login. The two pins of
  `WsCaller['kind']` (`client-types-drift.test.ts`, `role-names.test.ts`)
  are gone with the field. `eslint-rules/admin-counts.test.ts` reads the
  pin as 0.
- **Tests that compared a reader with the guard** (`gate-caller.test.ts`,
  `gate-login-update.test.ts`) compare the legacy shape on both sides.
- **Cells:** `server/web/lib/auth/admin-facts.db.test.ts`, in the full DB
  run (warn) and in `test:actor-on` and `test:edit-on` (on).

### Changed answers

None. Every `kind` decision c1 left stays on the session's role, as main;
no decision moved to adminFacts in c1 (the handlers move in c2 to c4).
The cells prove adminFacts answers what main decides, byte for byte
(JSON compared with main's SQL: `role = 'admin' and
mantle_login_is_admin(id)`, and `mantle_login_areas(id)` when that holds),
scoped and unscoped, for:

| login | admin | areas | legacy kind |
|---|---|---|---|
| Admin user | true | all five | admin |
| Admin user, keys area off | true | four, no keys | admin |
| role admin outside Admin (drift) | false | none | admin |
| role member inside Admin (drift) | false | none | member |
| member | false | none | member |

plus: a Login object getLoginOr401 did not answer has no legacy shape
(throws) and adminFacts answers it no; a scope for another login rejects;
a second ask in the request is the same promise. The guard and role
sweeps' snapshots (`server/web/server/__snapshots__/`) are unchanged
byte for byte (no `-u`), and the sweeps pass on the branch.

### Pins

Measured on the branch (P1b's counters); per package:

| pin | main | c1 | split on c1 |
|---|---|---|---|
| loginKindBranches | 50 | **48** | server/web/lib/auth 17 (was 19), rest of server/web 31 |
| loginRoleDecisionReads | 34 | 34 | server/web/lib/auth 5, rest of server/web 27, packages/content 1, packages/mcp-core 1 |
| adminDecisionFlags | 44 | 44 | server/web 14, packages/runtime 11, packages/content 5, server/api 5, packages/tools 4, packages/db 3, packages/client-types 2 (none in lib/auth) |
| loginTypeKindOrRole | 2 | **0** | the Login type test |

loginKindBranches in lib/auth: gone are getLoginOr401's two-shape answer,
`resolvedLoginId` and anyLoginScope's pick; `loginOf` (the Login and the
legacy shape of a resolved caller) adds one. Left in lib/auth: the
resolved caller's union (the session stays on the role until S8b; the
union goes at S8d) and the legacy readers (the rate-limit member flag,
the audit choice, the chat login). lib/auth's five role reads are the
pair helper, resolvedFor's two cases, memberLoginActive and
findMemberAsset, all until S8b.

No new lint `no-login-kind-branches`: `loginKindBranches` (arch:check,
down only) carries the count per file in its detail; the per-package
split is above. (The CEO ruled on it in fix round 1: no separate lint.)

### For c2 to c4

- Handlers read the legacy shape through `loginCaller()` /
  `publicLoginCaller()` today. Moving one: read its Login (a pipeline
  reader that answers the Login itself is c2's to add, registered in
  `eslint-rules/session-guards.mjs`), decide Admin with
  `adminFacts(login)`, and drop the `kind` branch. adminFacts answers the
  row's pair, not the session's role: a handler that decided on `kind`
  for a role admin outside Admin changes answer (narrower) when it moves;
  each such site is a named cell or stays on the legacy shape.
- `adminFacts` takes the login (`adminFacts(login)`), not the brief's
  `adminFacts()`: no new pipeline reader in c1.

### Gates

Mac (DATABASE_URL unset for unit runs), on the head that carries this
file:

| gate | exit |
|---|---|
| pnpm -r typecheck | 0 |
| pnpm lint | 0 |
| pnpm format:check | 0 |
| pnpm docs:check | 0 |
| pnpm arch:check | 0 |
| pnpm -C server/web build | 0 |
| pnpm exec vitest run server packages eslint-rules | 0 |
| pre-push `pnpm verify` (db9a4a40e) | 0 |

The first Mac run (before the pins and this file) answered arch 1 (the
spec went to 350 lines; cut back to 345) and unit 1 (the heading code
`S8c` was in no list; added to HISTORY_HEADING_CODES); both 0 after.

Workstation (own clone `s8c-c1-clone` at db9a4a40e, the code this head
carries; own `s8c-pg`, pgvector pg18, max_connections=450, port 56181;
MANTLE_CHECK_FLOOR=keep; systemd-run --user; --maxWorkers=3; one at a
time). Every set passed on its first run, no rerun:

| run | exit | result |
|---|---|---|
| the touched files first (lib/auth, workspaces, grants, middleware, access keys, shell) | 0 | 28 files, 294 passed |
| full vitest with DB | 0 | 1126 files, 13855 passed, 1 skipped |
| test:actor-off | 0 | 128 files, 1166 passed, 1 skipped |
| test:actor-on | 0 | 30 files, 366 passed, 1 skipped |
| test:edit-on | 0 | 42 files, 536 passed |
| test:matrix | 0 | 4 files, 8 passed |
| test:runtime-role, full config | 0 | 277 files, 2769 passed, 1 skipped |

The commit after db9a4a40e changes no code the DB runs read (pins, the
spec line, a heading code, this file).

### Fix round 1

The audit at f6268f405 found no widening against main. Its items, fixed
on the branch rebased onto main at 16c5e0311 (v0.300.108, the client.ts
split; no conflict). Each has a cell in
`server/web/lib/auth/admin-facts.db.test.ts`:

| item                                                                                                                                                                                                                                                                  | fix                                                                                                                                                                                                                                | cell                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| MED: the memo was keyed by request context and lowercased login id, so a copy (spread, or the id upper-cased) asked after the real Login answered Admin, and after a demotion, `forgetRequestLogins()` and a fresh `getLoginOr401()` the stale Admin answer came back | `login.ts`: the memo is a `WeakMap<Login, { row?, scopes }>` on the very Login object, and `loginAdminPair` is checked before it (a Login with no pair answers no without touching the memo)                                       | "a copy asked after the real Login in the same request answers no, scoped or not"; "demote, forget, find again: the fresh Login answers the demotion" |
| LOW: `loginOf` / `loginLegacy.set` left the Login writable, so an overwritten `loginId` kept its entry                                                                                                                                                                | `session.ts`: the Login (and a copy of its actor) and its legacy shape are frozen; the entry stores the login id and answers only while the object still names it (`legacyEntry`)                                                  | "an overwritten loginId borrows no pair"                                                                                                              |
| LOW: the `scope` memo key did not tell two scopes for one login apart                                                                                                                                                                                                 | keyed on the workspace scope object (`currentWorkspaceScope()`), as `scopeHoldsAdmin` keys its own (`packages/db/src/gateway/scope-answers.ts`)                                                                                    | "two scopes for one login each ask: an app run without Admin answers no"                                                                              |
| LOW: a failed scope ask was silent                                                                                                                                                                                                                                    | `scopeFacts` failures are logged (`console.warn`, the login id and the error) and still answer no; the row path already logs a lost grant through `loginAreas` (`loginFactFailed`)                                                 | (the log line; no cell)                                                                                                                               |
| LOW: the scoped cells went only through `withViewer`                                                                                                                                                                                                                  | one cell through the real any-login request scope: a request slot on an any-login write row of the route manifest, `getLoginOr401` enters the login's scope (`enterLoginScope`, writes on), byte-equal to main for all five logins | "through the real any-login request scope (enterLoginScope, read-write)"                                                                              |

The memo is now per Login object and scope, not per request: a second
`getLoginOr401()` in one request is a fresh find and asks again (one
round trip more on that rare path, the honest answer after a change).

#### Changed answers

None against main: no decision reads adminFacts yet. Against c1 as built,
narrower only: a copy, or a Login found again after a demotion, answers
no where the old memo answered the first Login's Admin.

#### CEO rulings (2026-10-20, after the audit)

- No separate `no-login-kind-branches` lint: the `loginKindBranches`
  counter (arch:check, only down, per file in its detail) suffices.
- The `adminFacts(login)` signature (the login passed in, not the brief's
  `adminFacts()`) is accepted.
- `loginRoleDecisionReads` is pinned at its measure (34) and only goes
  down; the brief's "1" was wrong.

#### Before the pair goes: what `mantle_scope_is_admin()` trusts

`mantle_scope_is_admin()` trusts only `mantle.ws` (the scope holds the
live Admin workspace): it checks no brain id, no membership of the
scope's login and no disabled login. adminFacts is safe today only with
the row's pair ANDed in (role admin AND a user of Admin, read with the
login row). Before S8b drops the pair, its SQL function needs the owner
(brain) and membership checks (the scope's login a user of that Admin
workspace now, enabled), with cells.

#### For c2: two latent narrowings to cover with cells

When a handler moves from the legacy `kind` to `adminFacts(login)`:

1. **An app-run scope answers no.** A login running an app
   (`withViewer({ login, app })`) is in a scope without Admin, so
   adminFacts answers no there even for an Admin user (the cell above
   shows it). A handler that decided Admin on `kind` inside such a scope
   narrows: a cell per site, or ask outside the app scope.
2. **The row's pair, not the role.** A role admin outside Admin (drift)
   has legacy `kind` 'admin' but adminFacts answers no. A handler that
   decided on `kind` for such a login narrows: a cell per site, or it
   stays on the legacy shape until S8b.
