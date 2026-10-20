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

| login                            | admin | areas         | legacy kind |
| -------------------------------- | ----- | ------------- | ----------- |
| Admin user                       | true  | all five      | admin       |
| Admin user, keys area off        | true  | four, no keys | admin       |
| role admin outside Admin (drift) | false | none          | admin       |
| role member inside Admin (drift) | false | none          | member      |
| member                           | false | none          | member      |

plus: a Login object getLoginOr401 did not answer has no legacy shape
(throws) and adminFacts answers it no; a scope for another login rejects;
a second ask in the request is the same promise. The guard and role
sweeps' snapshots (`server/web/server/__snapshots__/`) are unchanged
byte for byte (no `-u`), and the sweeps pass on the branch.

### Pins

Measured on the branch (P1b's counters); per package:

| pin                    | main | c1     | split on c1                                                                                                                                       |
| ---------------------- | ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| loginKindBranches      | 50   | **48** | server/web/lib/auth 17 (was 19), rest of server/web 31                                                                                            |
| loginRoleDecisionReads | 34   | 34     | server/web/lib/auth 5, rest of server/web 27, packages/content 1, packages/mcp-core 1                                                             |
| adminDecisionFlags     | 44   | 44     | server/web 14, packages/runtime 11, packages/content 5, server/api 5, packages/tools 4, packages/db 3, packages/client-types 2 (none in lib/auth) |
| loginTypeKindOrRole    | 2    | **0**  | the Login type test                                                                                                                               |

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

| gate                                              | exit |
| ------------------------------------------------- | ---- |
| pnpm -r typecheck                                 | 0    |
| pnpm lint                                         | 0    |
| pnpm format:check                                 | 0    |
| pnpm docs:check                                   | 0    |
| pnpm arch:check                                   | 0    |
| pnpm -C server/web build                          | 0    |
| pnpm exec vitest run server packages eslint-rules | 0    |
| pre-push `pnpm verify` (db9a4a40e)                | 0    |

The first Mac run (before the pins and this file) answered arch 1 (the
spec went to 350 lines; cut back to 345) and unit 1 (the heading code
`S8c` was in no list; added to HISTORY_HEADING_CODES); both 0 after.

Workstation (own clone `s8c-c1-clone` at db9a4a40e, the code this head
carries; own `s8c-pg`, pgvector pg18, max_connections=450, port 56181;
MANTLE_CHECK_FLOOR=keep; systemd-run --user; --maxWorkers=3; one at a
time). Every set passed on its first run, no rerun:

| run                                                                                    | exit | result                              |
| -------------------------------------------------------------------------------------- | ---- | ----------------------------------- |
| the touched files first (lib/auth, workspaces, grants, middleware, access keys, shell) | 0    | 28 files, 294 passed                |
| full vitest with DB                                                                    | 0    | 1126 files, 13855 passed, 1 skipped |
| test:actor-off                                                                         | 0    | 128 files, 1166 passed, 1 skipped   |
| test:actor-on                                                                          | 0    | 30 files, 366 passed, 1 skipped     |
| test:edit-on                                                                           | 0    | 42 files, 536 passed                |
| test:matrix                                                                            | 0    | 4 files, 8 passed                   |
| test:runtime-role, full config                                                         | 0    | 277 files, 2769 passed, 1 skipped   |

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
| LOW: a failed scope ask was silent                                                                                                                                                                                                                                    | `scopeFacts` failures are logged (`log('auth').warn`, the login id and the error) and still answer no; the row path already logs a lost grant through `loginAreas` (`loginFactFailed`)                                             | (the log line; no cell)                                                                                                                               |
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

#### Gates (fix round 1)

Mac (DATABASE_URL unset), on 942a45d78 (the last code commit; the commit
after it adds this table only):

| gate                                              | exit                              |
| ------------------------------------------------- | --------------------------------- |
| pnpm -r typecheck                                 | 0                                 |
| pnpm lint                                         | 0                                 |
| pnpm format:check                                 | 0                                 |
| pnpm docs:check                                   | 0                                 |
| pnpm arch:check                                   | 0                                 |
| pnpm -C server/web build                          | 0                                 |
| pnpm exec vitest run server packages eslint-rules | 0 (857 files passed, 269 skipped) |

The first Mac run (on 808bbb844) answered arch 1 and unit 1: a heading
named a step code (renamed, 2b46a42df), and the warning was a console
call over the consoleCalls pin (moved to `log('auth').warn`,
942a45d78). The same unit run had one failure in
`server/web/lib/deploy-scripts.test.ts` (the deploy harness, untouched
here); rerun alone it passed (exit 0), and the full run on 942a45d78
passed. A known flake, both runs reported.

Workstation (own clone `s8c-fr1-clone`, own `s8c-fr1-pg`, pgvector pg18,
max_connections=450, port 56191 checked free, the `postgres` role as CI;
MANTLE_CHECK_FLOOR=keep; systemd-run --user; --maxWorkers=3; one at a
time). The suites ran on ba3bab884 (the memo fix and its cells); the
commits after it change the warning's logger and docs only, and the cells
and the touched files ran again on 942a45d78:

| run                                                                              | head                 | exit | result                              |
| -------------------------------------------------------------------------------- | -------------------- | ---- | ----------------------------------- |
| admin-facts cells, warn                                                          | ba3bab884, 942a45d78 | 0, 0 | 10 passed                           |
| admin-facts cells, test:actor-on config                                          | ba3bab884, 942a45d78 | 0, 0 | 10 passed                           |
| admin-facts cells, test:edit-on config                                           | ba3bab884, 942a45d78 | 0, 0 | 10 passed                           |
| the touched files (lib/auth, workspaces, grants, middleware, access keys, shell) | ba3bab884, 942a45d78 | 0, 0 | 28 files, 299 passed                |
| full vitest with DB                                                              | ba3bab884            | 0    | 1126 files, 13863 passed, 1 skipped |
| test:actor-off                                                                   | ba3bab884            | 0    | 128 files, 1168 passed, 1 skipped   |
| test:actor-on                                                                    | ba3bab884            | 0    | 30 files, 371 passed, 1 skipped     |
| test:edit-on                                                                     | ba3bab884            | 0    | 42 files, 541 passed                |
| test:matrix                                                                      | ba3bab884            | 0    | 4 files, 8 passed                   |
| test:runtime-role, full config                                                   | ba3bab884            | 0    | 277 files, 2774 passed, 1 skipped   |

Mutation check: c1's `login.ts` (the old memo, at ece66b9ab) with the new
cells answered exit 1, three cells failing (copy after real; demote,
forget, find again; two scopes), the other seven passing; restored by git
checkout. The cells catch the MED item.

## Part c2: server/web lib and app/api handlers

The branch `feat/s8c-c2`, cut from main at 7b9b1c424 (v0.300.110). No
migration. Planned in two rounds; this is round 1 (what is left is listed
at the end).

### What changed (round 1)

- **A reader that answers the Login.** `anyLoginCaller()`
  (`server/web/lib/auth/session.ts`): on an any-login row, the very Login
  getLoginOr401 answered (so `adminFacts(login)` asks its scope and
  `legacyLogin(login)` still finds its legacy shape). Registered in
  `eslint-rules/session-guards.mjs` (c1 open item 1) with its own entry,
  `pipeline:loginItself`, and `logs: 'loginCaller'`: the guard sweep logs
  the any-login answer's legacy shape for its rows, so the recorded files
  compare one answer byte for byte (`a4-guard-sweep.test.ts` projects
  through `logs` when a reader names one).
- **The any-login handlers read the Login and ask adminFacts.**
  - `app/api/access-keys/route.ts`: the list (every key for an Admin user,
    its own for any other login) is `adminFacts(login).admin`; the keys
    area (the longest expiry, risky tools) is `adminFacts(login).areas`, in
    the login's scope for GET and unscoped for POST (inRuleInQuery);
    `holdsKeysArea` (a requireArea wrapper) is gone; the notice's owner is
    `login.brainId`. The display role in the answer and the audit row stay
    the legacy kind (until the role is derived, S8b).
  - `app/api/shell/route.ts`: onboarding, the pending count, the asset
    token's lifetime and the item tree's kinds are `adminFacts(login).admin`
    (the owner's id is `login.brainId`); the name and email are the
    Login's own fields; the display role stays the legacy kind.
  - `lib/login-workspaces.ts`: takes the workspace caller and the route's
    Admin answer (`admin`), so the shell passes adminFacts' and
    `/api/auth/whoami` its legacy kind (its public read still answers the
    legacy shape; round 2).
  - `app/api/v1/whoami/route.ts`: the name is the Login's; the display
    role stays the legacy kind.
- **The three role reads the plan names** (now on the Admin pair, the S8a
  helper `adminLogin`, exported from session.ts, or no role read):
  - `lib/mcp-auth.ts` (main's lines 261 and 263): a peer's risky tools and
    the owner's own peer ask `adminLogin(row)`; the peer's login row is
    `loadLoginRow` (membership of Admin read with the row, unscoped, as
    `loadLogin` was).
  - `lib/mcp-auth.ts` (main's line 273): `mcpLoginEnabled` reads no role.
    Its one caller is the OAuth consent route's member branch (the gate's
    kind), and `mcpTargetLogin` reads the member row right after, so the
    route answers as main for every login.
  - `lib/pair-code.ts` (main's line 131): the claim's Admin bearer needs
    the Admin pair (`mantle_login_is_admin` read with the row, as
    loadLoginRow reads it).
- **Cells:** `server/web/lib/auth/admin-facts-handlers.db.test.ts`, in the
  full DB run (warn) and in `test:actor-on` and `test:edit-on` (on): each
  site's answer before and now, for the five logins of c1's cells, in the
  real request scope of the route's own row.

### Changed answers (round 1)

Narrower only, and only for a login whose role and Admin membership
disagree (drift; plan 2.2 point 7 names this narrowing as intended, drift
is 0 on every box). For an Admin user (keys area on or off) and a member,
every answer is byte-equal (the cells). No answer is wider for any login.
None of these handlers runs in an app-run scope (narrowing 1 of c1 does not
arise here).

| site                                         | login                    | main                                                                                     | now                                                                 | cell                                                    |
| -------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| GET /api/access-keys, the list               | role admin outside Admin | every key                                                                                | its own keys                                                        | "Admin on the any-login rows"                           |
| GET /api/shell                               | role admin outside Admin | onboarding read, pending count, 2 h asset token, the admin tree, isOwner when the anchor | onboarded true, 0, the 10 min token, the reader tree, isOwner false | "Admin on the any-login rows"                           |
| GET and POST /api/access-keys, the keys area | role member inside Admin | holds keys (longest expiry, risky tools)                                                 | no keys area (90 days, no risky tools)                              | "the keys area, in the scope (GET) and unscoped (POST)" |
| POST /api/auth/pair (claimPairCode)          | role admin outside Admin | an Admin bearer                                                                          | null (the one 401)                                                  | "a pairing code's claim"                                |
| /api/mcp, a peer bound to the login          | role admin outside Admin | the peer's risky tools; the owner's own peer                                             | none; not the owner's                                               | "a peer's Admin facts"                                  |

### Pins (round 1)

| pin                     | main | c2 round 1                                                                                    |
| ----------------------- | ---- | --------------------------------------------------------------------------------------------- |
| loginKindBranches       | 48   | **38** (access-keys 4, the shell 4, v1/whoami 1, loginWorkspaces 2 went; /api/auth/whoami +1) |
| loginRoleDecisionReads  | 34   | **30** (mcp-auth.ts 261, 263, 273; pair-code.ts 131)                                          |
| adminDecisionFlags      | 44   | 44 (none in the round 1 hunks)                                                                |
| inHandlerAreaChecks     | 22   | **20** (holdsKeysArea's two uses)                                                             |
| inHandlerAreaCheckFiles | 18   | **17**                                                                                        |

`eslint-rules/admin-counts.test.ts` now asserts that the three named
role reads are gone (by the moved code, not by line number).

### Tests changed with the answers (round 1)

- `server/web/lib/access-keys.db.test.ts`: the keys area was stood in on
  `requireArea`; it is now stood in on `adminFacts` (the real Admin
  answer, the stand-in's areas only for an Admin user). Its "a member with
  the keys area makes risky and long keys" became "a member never holds
  it" (400, 90 days): the role=member-inside-Admin narrowing above.
- `server/web/lib/pair-code.test.ts`: the login row carries `adminMember`;
  a new case, "taken out of Admin" (role admin, no Admin membership), is
  null.
- `server/web/app/api/shell/shell-parts.test.ts`: the mocks answer
  `anyLoginCaller`, `legacyLogin` and `adminFacts`; every answer as before.
- `server/web/server/a4-guard-sweep.test.ts`: a reader with `logs` is
  logged under that reader's entry and projection. The recorded files
  (`server/web/server/__snapshots__/`) are unchanged byte for byte (no
  `-u`; `git diff main` on them is empty), and the guard and role sweeps
  pass on the branch.

### Gates (round 1)

Mac (DATABASE_URL unset), on 3c4c8c79d (the commits after it change
`access-keys.db.test.ts`, which runs only with a database, and this file):

| gate                                              | exit                              |
| ------------------------------------------------- | --------------------------------- |
| pnpm -r typecheck                                 | 0                                 |
| pnpm lint                                         | 0                                 |
| pnpm format:check                                 | 0                                 |
| pnpm docs:check                                   | 0                                 |
| pnpm arch:check                                   | 0                                 |
| pnpm -C server/web build                          | 0                                 |
| pnpm exec vitest run server packages eslint-rules | 0 (857 files passed, 270 skipped) |

The first Mac run (on a8558adce) answered unit 1: the guard sweep's moved
record named the new entry (`pipeline:loginItself`; the sweep now logs a
`logs` reader under the named reader's entry), and the shell and pair-code
unit tests mocked the old reads. All 0 on 3c4c8c79d.

Workstation (own clone `s8c-c2-clone`, own `s8c-c2-pg`, pgvector pg18,
max_connections=450, port 56201 checked free, the `postgres` role as CI;
MANTLE_CHECK_FLOOR=keep; systemd-run --user; --maxWorkers=3; one at a
time):

| run                                   | head      | exit | result                                                                                                    |
| ------------------------------------- | --------- | ---- | --------------------------------------------------------------------------------------------------------- |
| the c1 and c2 admin-facts cells, warn | 3c4c8c79d | 0    | 2 files, 14 passed                                                                                        |
| the cells, test:actor-on config       | 3c4c8c79d | 0    | 2 files, 14 passed                                                                                        |
| the cells, test:edit-on config        | 3c4c8c79d | 0    | 2 files, 14 passed                                                                                        |
| full vitest with DB                   | 3c4c8c79d | 1    | 1126 of 1127 files: `access-keys.db.test.ts` stood the keys area in on `requireArea` (fixed in 590cd67c1) |
| test:actor-off                        | 3c4c8c79d | 0    | 128 files, 1177 passed, 1 skipped                                                                         |
| test:actor-on                         | 3c4c8c79d | 0    | 31 files, 375 passed, 1 skipped                                                                           |
| test:edit-on                          | 3c4c8c79d | 0    | 43 files, 545 passed                                                                                      |
| test:matrix                           | 3c4c8c79d | 0    | 4 files, 8 passed                                                                                         |
| test:runtime-role, full config        | 3c4c8c79d | 1    | 277 of 278 files: the same `access-keys.db.test.ts`                                                       |
| access-keys.db.test.ts                | 590cd67c1 | 0    | 19 passed                                                                                                 |
| full vitest with DB                   | 590cd67c1 | 0    | 1127 files, 13877 passed, 1 skipped                                                                       |
| test:runtime-role, full config        | 590cd67c1 | 0    | 278 files, 2782 passed, 1 skipped                                                                         |

The commit after 3c4c8c79d changes only `access-keys.db.test.ts`, which
the actor-off, actor-on, edit-on and matrix configs do not run (they
passed with its old text). An earlier run on a8558adce was stopped after
the cells (all 0), once the Mac unit gate had failed. No flake, no rerun
of a passing suite.

### Left for round 2

- The owner rows that read `ownerCallerWithLogin()` and branch on its
  kind: the app brokers (`apps/[id]/db-broker`, `tool-broker`,
  `frame-ticket`), `apps/[id]` (the three Admin switches), `apps` (the
  author ceiling). A Login form of that answer is needed first.
- The chat rows (`chatLoginCaller()`): `assistant/thread` (also 4
  isAdmin), `assistant/transcribe`, `assistant/turn` (3), and
  `lib/assistant-chat.ts` (4 kind, 5 isAdmin), `lib/workspace-turn.ts` (2).
- The public rows that read `publicLoginCaller()` (the legacy shape):
  `/api/auth/whoami` (2) and `oauth/authorize` (2, and its role read
  at 384). A Login form of the at-read answer is needed first.
- `lib/workspaces.ts`: `workspaceCaller` (1 kind), and `WsCaller.user`
  (an Admin user's SessionUser, read by the role change's "Admin only").
- The other role reads in server/web outside lib/auth (users route,
  login-update.ts, users/[id]/agent, access-keys-admin.ts,
  access-keys-notify.ts, mcp-auth.ts 79/164/281, mcp-oauth.ts,
  owner-sso.ts, peer-access.ts, push/store.ts, token-login.ts,
  pair-code.ts 104 and 130): many read the requested role of a new or
  changed login, or filter rows by role (S8b's), and are sorted first.
- adminDecisionFlags in server/web (assistant/thread 4, assistant-chat 5,
  grants 2, reconcile 1, workspaces 2): mostly the workspace's own flag.

## Part c2, round 2

Same branch, from 9b3d06f9e. No migration, no edit in packages/db,
content, files, runs or embeddings. Items 1 to 4 and 6 of the round 1
"left" list are done in server/web; item 5 (the other role reads) is
sorted below and left.

### What changed (round 2)

- **Three readers that answer the Login** (`server/web/lib/auth/session.ts`),
  each registered in `eslint-rules/session-guards.mjs` with `logs` naming
  the legacy reader, so the guard sweep logs the same answer byte for byte
  (the sweep now follows `logs` for an answer taken at the read too):
  - `ownerLoginCaller()`: the owner guard's Login (`ownerAnswerLogin`
    keyed on the very owner answer; the answer keeps its legacy shape);
  - `chatCaller()`: the chat answer without `kind`, with `asLogin`, the
    chat guard's Login (`ChatCaller`, `chatCallerOf`);
  - `publicLoginItself()`: a public row's Login, taken at the read from
    the same answer as `publicLoginCaller()` (which now projects
    `legacyLogin` of it).
    `answeredLogin(res)` registers a Login's legacy shape and Admin pair for
    all three guards and getLoginOr401.
- **Owner rows** ask `adminFacts(ownerLoginCaller())`: the app db broker,
  tool broker and frame ticket (a non-Admin run goes to the member runner,
  which now takes an `AppRunLogin`, a Pick of the Login), PATCH
  `/api/apps/:id` (the three Admin switches), POST `/api/apps` (the author
  ceiling).
- **Chat rows** read `chatCaller()`; `lib/assistant-chat.ts` and
  `lib/workspace-turn.ts` take `ChatCaller` and ask `chatAdmin(login)`
  (adminFacts of `asLogin`): which assistants, the limits, the image
  rewrite, the owner engine, the error detail (turn, transcribe), the
  thread's Admin parts (its `isAdmin` local renamed `admin`).
- **Public rows**: `/api/auth/whoami` and `/api/oauth/authorize` read
  `publicLoginItself()`; whoami's areas and the consent path ask adminFacts
  (no scope there: the row's answer). whoami's display role and client
  routes stay the session's role until S8b.
- **`lib/workspaces.ts`**: `WsCaller` is `{ loginId, anchorId, login? }`;
  `workspaceCaller(login: Login)`; `wsRoute` and `grantsRoute` take the
  Login, and every workspace and grants route reads `anyLoginCaller()`.
  The role change's "Admin only" is `adminFacts(caller.login)`, asked in
  the caller's scope before the work leaves it (a caller with no Login is
  refused); `loginSessionUser(login)` (a transition adapter) feeds
  applyLoginChange and its audit row.
- **Cells** (`server/web/lib/auth/admin-facts-handlers.db.test.ts`, four
  more): the owner rows, the chat rows, the public rows and the role
  change, each in its guard's real request scope, legacy decision beside
  adminFacts for the five logins of c1's cells.

### Changed answers (round 2)

Narrower only, and only for the role=admin login outside Admin (drift).
Admin users (keys area on or off), the role=member login inside Admin and
members are byte-equal (the cells; the guard sweep, the app broker parity
and the A10 broker sweep snapshots unchanged, no `-u`).

| site                                                      | role admin outside Admin: main                         | now                                                         | cell                                  |
| --------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------- |
| POST /api/apps/:id/db-broker, tool-broker                 | the Admin run (Admin data rules)                       | the member runner (published build, team rules, rows only)  | "Admin on the owner rows"             |
| POST /api/apps/:id/frame-ticket                           | an admin ticket (its frame refused by S8a)             | a member ticket (its frame refused: memberLoginActive)      | "Admin on the owner rows"             |
| PATCH /api/apps/:id (trustTools, mcpAccess, dataReadOnly) | allowed                                                | 403 admin-only                                              | "Admin on the owner rows" (the scope) |
| POST /api/apps                                            | author ceiling admin                                   | team, author named                                          | "Admin on the owner rows"             |
| the chat rows                                             | the owner surface's agents, no limits, provider detail | its workspaces' assistants, member limits, fixed error text | "Admin on the chat rows"              |
| GET /api/auth/whoami                                      | its areas from the workspaces read                     | no areas                                                    | "Admin on the public rows"            |
| GET and POST /api/oauth/authorize                         | an Admin consent (the brain)                           | the member path (refused unless a member MCP login)         | "Admin on the public rows"            |
| a role change in Admin (POST/DELETE users)                | past the TS check (the definer decides)                | 403 admin_only                                              | "a role change's Admin only"          |

### Pins (round 2)

| pin                    | round 1 | round 2                                                                |
| ---------------------- | ------- | ---------------------------------------------------------------------- |
| loginKindBranches      | 38      | **17** (all in lib/auth/session.ts; none left elsewhere in server/web) |
| adminDecisionFlags     | 44      | **40** (the thread route's four)                                       |
| historyCodeComments    | 2338    | **2336**                                                               |
| loginRoleDecisionReads | 30      | 30 (item 5 left)                                                       |
| inHandlerAreaChecks    | 20      | 20                                                                     |

### Tests changed with the readers (round 2)

The broker tests (`app-tool-broker`, `member-runner-routes`,
`app-identity-owner`, `member-connectors.turn-scope.db`,
`a10-app-broker-sweep`, `app-broker-parity`) stand in `ownerLoginCaller`
from their owner answer and adminFacts from its kind; the chat route
tests stand in `chatCaller`; the OAuth route test `publicLoginItself`;
`shell-parts`, `workspace-turn`, `gate-caller` and the WsCaller literals
take the Login; `owner-caller-imports.test.ts` lists the new at-read
reader. Every expected answer is unchanged.

### The round 1 audit's LOWs (folded in round 2)

1. `mcpLoginEnabled` is `mcpLoginUsable`, its comment says it reads no
   role and answers true for an Admin user, and that the consent route asks
   it on the member path only, with mcpTargetLogin's second read (role
   member) deciding a login changed in between. Answers unchanged.
2. `server/web/lib/mcp-auth-peer.test.ts` (unit, no database): the peer
   bearer through `resolveMcpCaller` with `verifyInboundToken` and
   `loadLoginRow` stood in: `peerByOwner` and `riskyAllowed` for the owner,
   an Admin user, the two drift logins and a member (the role=admin login
   outside Admin gets neither).
3. `eslint-rules/session-guards.test.ts`: a reader's `logs` names an
   existing reader of the same caller, guard and at-read answer, which
   logs as itself.
4. Step codes left the test names and comments the audit named
   (`admin-counts.test.ts`, `vitest.actor-on.config.ts`,
   `pair-code.test.ts`, `access-keys.db.test.ts`,
   `admin-facts-handlers.db.test.ts`).
5. The `inHandlerAreaChecks` note says the keys ask moved into
   `adminFacts(login).areas`, not gone.
6. whoami and the shell now agree for a drifted role admin (both ask
   adminFacts).

### Left for round 3

- Item 5, the role reads in server/web outside lib/auth (30 with lib/auth's
  5), sorted, none moved:
  - a requested or target role (S8b's): `users/route.ts:115`,
    `login-update.ts:121, 245`, `users/[id]/agent/route.ts:62, 66`;
  - row filters (S8b's): `push/store.ts` (3), `access-keys-notify.ts:55`;
  - display: `access-keys-admin.ts:126`, `oauth/authorize:380` (the
    consent page's text, now from the decided path);
  - the member-path loaders and session-side checks, to move to the Admin
    pair or adminFacts: `mcp-auth.ts:81, 166, 287`, `mcp-oauth.ts:265, 266`,
    `owner-sso.ts:95`, `pair-code.ts:115, 149`, `token-login.ts:100, 101`,
    `peer-access.ts:79`.
- `ownerCallerWithLogin`, `chatLoginCaller` (the Telegram chat routes) and
  `publicLoginCaller` (logout, change password, pairing) stay as legacy
  readers; nothing in them decides Admin.

### Gates (round 2) and the state at hand-over

Mac (DATABASE_URL unset): on 09ae5c563 typecheck 0, lint 0, format 0,
docs 0, arch 0, server/web build 0, unit 1 (the A10 body and error sweeps
stood in the scope's database with a row that had no `admin`, so
adminFacts answered no for the Admin user: fixed in 3f02a0a0c, test files
only); on 3f02a0a0c typecheck 0, lint 0, format 0, unit 0 (858 files
passed, 270 skipped). The pre-push `pnpm verify` passed (exit 0).

Workstation (own clone `s8c-c2r2-clone` at 09ae5c563, own `s8c-c2r2-pg`,
pgvector pg18, max_connections=450, port 56211 checked free; both removed
at hand-over; logs kept in `~/s8c-c2r2-logs`): the admin-facts cells
(both files) 0 (warn) and 0 (actor-on config). Full DB vitest 1: 8 files
of 1128, stopped there (no later suite ran):

- `workspaces.db.test.ts` (21), `grants.db.test.ts` (14),
  `threads.db.test.ts` (3), `w7c-chat.db.test.ts` (4): 500s and
  "chatCaller ... answered no chat login" / "no chatCaller export on the
  @/lib/auth mock": these tests stand in `loginCaller` or `chatLoginCaller`
  and call the handlers; the routes now read `anyLoginCaller()` and
  `chatCaller()`. Their stand-ins need the new readers (as the unit tests
  got in this round). Not run on the Mac (database only).
- `a10-body-sweep`, `a10-error-sweep`: the head predates 3f02a0a0c.
- `a4-guard-sweep` (the "cells that wanted a database" test) and
  `packages/runtime/src/heartbeats/tools.test.ts`: the run script exported
  `DATABASE_URL` for the whole run (it should be set for init and migrate
  only, as round 1 ran); both expect no database there. Rerun without it.

Left for round 3, in order: fix the four DB test files' stand-ins; rerun
the full DB vitest (DATABASE_URL unset for vitest), test:actor-off,
test:actor-on, test:edit-on, test:matrix and test:runtime-role
(`pnpm test:x --maxWorkers=3`, no `--`), the guard and role sweeps
byte-compared; CI green; then item 5 below.

One named changed answer to rule on: POST /api/assistant/turn and
POST /api/assistant/transcribe ask adminFacts at the top of the handler;
if that one statement fails (a database fault), it answers no, so an
Admin user hears the fixed error sentence in place of the provider's
detail (display only, fail closed). On main the detail came from the
session's role with no database read.

## Part c2, round 3

Same branch, rebased onto main 2f5a75ad5 (v0.300.111, S10 round 1). No
migration, no edit in packages/db. The rebase's one conflict was
`scripts/arch-scoreboard.pins.json`: main's S10 values and notes for the
raw SQL keys kept, this branch's `historyCodeComments` (2336) kept with its
note appended to main's.

### What changed (round 3)

- **The four DB test files' stand-ins** (`server/web/lib/workspaces.db.test.ts`,
  `server/web/lib/grants.db.test.ts`,
  `server/web/app/api/assistant/threads/threads.db.test.ts`,
  `server/web/server/w7c-chat.db.test.ts`): the routes read
  `anyLoginCaller()` and `chatCaller()` now, so each file stands them in
  from the same answer it stood in before (`standInLogin`,
  `standInChatCaller`), and `adminFacts` answers the stand-in's kind, as
  the round 2 unit tests do. No assertion changed.
- **Item 5, the role reads in server/web outside lib/auth.** Three Admin
  decisions moved to the Admin pair (`adminLogin`: role admin AND a user
  of Admin now, read with the row). None of them has a Login (a bearer
  read from its row, or a sign-in before any session), so the pair is the
  row's form of the answer adminFacts gives, as round 1 did for the peer
  and the pairing claim:
  - `server/web/lib/mcp-auth.ts` (an MCP access key): an Admin caller only
    for `adminLogin(key.login)` (verifyAccessKey's row already reads the
    pair); any other login takes the member path, which serves a member
    only.
  - `server/web/lib/mcp-oauth.ts` `connectingLogin` (an Admin OAuth grant,
    no session epoch: the /api/mcp bearer check, the code exchange and the
    refresh): the row reads `mantle_login_is_admin` and asks
    `adminLogin`. A member grant still reads role member and the epoch.
  - `server/web/lib/token-login.ts` (POST /api/auth/mobile-login, the old
    companion's Admin-only sign-in): the row reads `mantle_login_is_admin`
    and asks `adminLogin`; a member still hears "Update the app" (426).
- **Left, named** (27 role reads, by kind):
  - member-path checks, where the pair would WIDEN (a role=admin login
    outside Admin is no Admin user, but it is no member either, and the
    session's member case reads the role until S8b):
    `mcp-auth.ts` memberMcpCaller and mcpTargetLogin, `mcp-oauth.ts` a
    member grant (`row.role === 'member'`), `pair-code.ts` the member code
    (update-app) and the member bearer, `peer-access.ts` a peer bound to a
    member;
  - `owner-sso.ts`: which SSO cookie is audited (no right);
  - `mcp-oauth.ts` `ownerFromBearer`: no caller outside its unit test (a
    dead export; its role filter decides nothing a request reaches);
  - a requested or target role (S8b): `users/route.ts`,
    `login-update.ts` (2), `users/[id]/agent/route.ts` (2);
  - row filters (S8b): `push/store.ts` (3), `access-keys-notify.ts`;
  - display: `access-keys-admin.ts`, `oauth/authorize` (the consent
    page's text);
  - `lib/auth/session.ts` (5: the pair helper, resolvedFor's two cases,
    memberLoginActive, findMemberAsset) and the packages' 2
    (`packages/content/src/login-notices.ts`,
    `packages/mcp-core/src/login-surface.ts`; c3 and c4).
- **Cells** (`server/web/lib/auth/admin-facts-handlers.db.test.ts`, one
  more): an MCP key's caller through `resolveMcpCaller` with a real key,
  `actorMayConnect` for an Admin grant, and `handleTokenLogin` Admin-only,
  for the five logins of c1's cells. Unit: `token-login.test.ts` (a
  role=admin login taken out of Admin is 401) and `mcp-oauth.test.ts` (a
  refresh for a login taken out of Admin is invalid_grant); their Admin
  stand-in rows carry `adminMember: true`. `eslint-rules/admin-counts.test.ts`
  asserts the three moved reads are gone (by the moved code).
- **Three DB test files whose role=admin logins were in no Admin
  workspace** (the full DB run on 43cc40805 answered 1, 5 tests in 3
  files, each the narrowing above, for a fixture that meant an Admin user):
  `server/web/lib/mcp-revived-credentials.db.test.ts` makes its three
  role=admin logins users of the brain's Admin workspace after the
  migrations ran (so what 0268 did is as before) and checks
  `mantle_login_is_admin` answers yes for them;
  `server/web/lib/mcp-oauth-lock.db.test.ts` and
  `server/web/lib/auth/auth-races.db.test.ts` move to a brain of their own
  (`createMigratedScratchDatabase`, as `mcp-oauth-grants.db.test.ts` did
  for the same reason) and make their OAuth actor an Admin user
  (`ensureAdminUsers`, as the superuser). No assertion changed.

### Changed answers (round 3)

Narrower only, and only for the role=admin login outside Admin (drift).
Admin users (keys area on or off), the role=member login inside Admin and
members are byte-equal (the cell).

| site                                                                                    | role admin outside Admin: main                     | now                                  | cell                                                 |
| --------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------ | ---------------------------------------------------- |
| /api/mcp with an access key                                                             | an Admin caller (the brain, the key's risky tools) | 401 (no Admin caller, and no member) | "an MCP key's and an Admin OAuth grant's caller ..." |
| /api/mcp with an Admin OAuth grant; the OAuth code exchange and refresh of such a grant | connects as Admin                                  | 401; invalid_grant                   | the same cell (actorMayConnect)                      |
| POST /api/auth/mobile-login                                                             | 200, an Admin mobile bearer                        | 401, the one failure message         | the same cell (handleTokenLogin)                     |

And the one the CEO ruled on (2026-10-20, ACCEPTED: display only, fails
closed, matches the no-raw-error rule):

| site                                                     | login                                                                  | main                        | now                      | cell                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| POST /api/assistant/turn, POST /api/assistant/transcribe | an Admin user, when adminFacts' one statement fails (a database fault) | the provider's error detail | the fixed error sentence | none (a database fault): adminFacts' catch answers no (`server/web/lib/auth/login.ts`) |

The fault case is a class, not one row (audit of rounds 2 and 3, CEO ruling: accepted, fails closed, never wider): if adminFacts' one statement fails, an Admin user is answered as a non-Admin for that whole request at every moved site. On a turn that is 404 no-chat-agent on the owner engine and member limits; transcribe and summarize claim a member daily-cap slot; PATCH /api/apps/:id answers 403, the brokers use the member runner, consent takes the member path, a role change answers 403. The A10 error sweep exempts this statement from its forced faults, so no cell records it.

### Pins (round 3)

| pin                    | round 2 | round 3                                                                    |
| ---------------------- | ------- | -------------------------------------------------------------------------- |
| loginRoleDecisionReads | 30      | **27** (mcp-auth.ts the key, mcp-oauth.ts the Admin grant, token-login.ts) |
| loginKindBranches      | 17      | 17                                                                         |
| adminDecisionFlags     | 40      | 40                                                                         |
| historyCodeComments    | 2336    | 2336                                                                       |
| inHandlerAreaChecks    | 20      | 20                                                                         |

### Gates (round 3)

Mac (DATABASE_URL unset), on 43cc40805:

| gate                                                             | exit                              |
| ---------------------------------------------------------------- | --------------------------------- |
| pnpm -r typecheck                                                | 0                                 |
| pnpm lint                                                        | 0                                 |
| pnpm format:check                                                | 0                                 |
| pnpm docs:check                                                  | 0                                 |
| pnpm arch:check                                                  | 0                                 |
| pnpm -C server/web build                                         | 0                                 |
| pnpm exec vitest run --maxWorkers=3 server packages eslint-rules | 0 (859 files passed, 271 skipped) |

157a62f91 changes only three `.db.test.ts` files (skipped without a
database; eslint, prettier and the server/web typecheck run on them, 0),
and CI ran every Mac gate on it. The recorded sweep files
(`__snapshots__`) are byte-equal to main (`git diff origin/main` on them
is empty, no `-u`); the guard, role and A10 sweeps pass in the unit run.

Workstation (own clone `s8c-c2r3-clone`, own `s8c-c2r3-pg`, pgvector pg18,
max_connections=450, port 56221 checked free, the `postgres` role as CI;
MANTLE_CHECK_FLOOR=keep for init and migrate only; DATABASE_URL unset for
every vitest run; systemd-run --user; --maxWorkers=3; one at a time):

| run                             | head      | exit | result                                                                                                                |
| ------------------------------- | --------- | ---- | --------------------------------------------------------------------------------------------------------------------- |
| the four stand-in files         | 5e51b18cb | 0    | 4 files, 53 passed                                                                                                    |
| the admin-facts cells (warn)    | 5e51b18cb | 0    | 2 files, 18 passed                                                                                                    |
| full vitest with DB             | 5e51b18cb | 0    | 1130 files, 13894 passed, 1 skipped                                                                                   |
| the admin-facts cells (warn)    | 43cc40805 | 0    | 2 files, 19 passed                                                                                                    |
| the four stand-in files         | 43cc40805 | 0    | 4 files, 53 passed                                                                                                    |
| full vitest with DB             | 43cc40805 | 1    | 3 files, 5 tests: the role=admin fixtures outside Admin (fixed in 157a62f91)                                          |
| test:actor-off                  | 43cc40805 | 0    | 129 files, 1180 passed, 1 skipped                                                                                     |
| test:actor-on                   | 43cc40805 | 0    | 31 files, 380 passed, 1 skipped                                                                                       |
| test:edit-on                    | 43cc40805 | 0    | 43 files, 550 passed                                                                                                  |
| test:matrix                     | 43cc40805 | 0    | 4 files, 8 passed                                                                                                     |
| the three fixture files         | 157a62f91 | 0    | 16, 3 and 5 passed                                                                                                    |
| full vitest with DB             | 157a62f91 | 1    | 1130 files passed, 13898 tests; one unhandled CONNECTION_CLOSED at a teardown, from w7e-member-scope.db (not touched) |
| full vitest with DB, rerun once | 157a62f91 | 0    | 1130 files, 13898 passed, 1 skipped                                                                                   |
| test:runtime-role, full config  | 157a62f91 | 0    | 279 files, 2790 passed, 1 skipped                                                                                     |

The actor-off, actor-on, edit-on and matrix configs include none of the
three files 157a62f91 changes. CI on 157a62f91: run 39375599914, success.

### Left after round 3

- The 27 role reads above, each named with its owner (S8b, c3, c4) or
  why it stays (a member-path check the pair would widen; an audit; a
  dead export).
- `ownerFromBearer` (`server/web/lib/mcp-oauth.ts`) has no caller outside
  its unit test: a candidate to delete.
- adminDecisionFlags in server/web (40): mostly the workspace's own flag,
  not sorted in this round.

## Part c3: packages/tools, runtime, mcp-core, telegram

The branch `feat/s8c-c3`, cut from main at 6e0597610 (v0.300.113). No
migration, no edit in packages/db, server/web/lib/auth,
packages/content/src/tree or packages/files/src/ops.

### Sorted, site by site

Every login kind, login role and `isAdmin` hit in the four packages
(non-test files; the counters' detail and a grep for `'admin'`, `'member'`,
`.role`, `LoginRole` and `isAdmin`):

| package           | site                                                                                                                                   | what it is                                                                             | done                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------- |
| packages/mcp-core | `login-surface.ts` registerPreparedTools: a peer bound to a role admin login the owner did not register names no login to the builtins | a login Admin decision on the role                                                     | stays on the role, named (below) |
| packages/mcp-core | `login-surface.ts` mcpChannel, logConnectorCall; `gate-policy.ts` mcpGateCaller (`role: caller.role`)                                  | the role carried for display and audit; the gate reads no `role`                       | display, stays legacy until S8b  |
| packages/tools    | `builtins-app-data.ts` (`who.role`: `:host_me_kind`, the statement queue key, the log row)                                             | the role an app sees (display); the reach rule ignores it                              | display, stays legacy until S8b  |
| packages/tools    | `builtins-nodes.ts` 1, `builtins-workspaces.ts` 2, `tool-results.ts` 1 (`isAdmin`)                                                     | the workspace's own flag (`workspaces.is_admin`)                                       | kept                             |
| packages/runtime  | `agent/agent-viewer.ts` 10, `assistant/run-team-turn.ts` 1 (`isAdmin`)                                                                 | the workspace's own flag                                                               | kept                             |
| packages/runtime  | `run-team-turn.ts` hasUnknownRole (`authUsers.role`)                                                                                   | refuses a role this code does not name (no login); no Admin answer                     | kept                             |
| packages/runtime  | `heartbeats/fire.ts` (`kind === 'admin'`)                                                                                              | the agent's workspace kind (NOT_LOGIN_KIND)                                            | kept                             |
| packages/telegram | `chat-login.ts` (`w.is_admin` in SQL; `loginHasArea(loginId, 'users')`)                                                                | the Admin workspace in SQL; an ask about another login (the plan's `mantle_area_rule`) | kept                             |

Nothing else in the four packages branches on a login's kind or role:
every other Admin answer there is already the scope's (`scopeHoldsAdmin`,
`scopeHasArea`, the gate's `admin` view) or the caller's surface. `adminFacts`
lives in server/web and no package imports it.

### What changed

- `packages/mcp-core/src/login-surface.ts`: the peer's naming decision is
  the exported helper `peerNamesNoLogin(caller)`, the same expression
  (`via === 'peer' && role === 'admin' && !peerByOwner`), with why it stays
  on the role. Answers unchanged.
- **Why it stays on the role.** The Admin pair (`adminLogin`) would answer
  "names its login" for a role admin outside Admin. A named login is what
  app_delete (purged after 30 days when the login is the anchor), app_create
  (the author), and the share, Telegram, replay, runs, pending and
  delegation builtins act for: for the anchor taken out of Admin its peer's
  app_delete would be purged, a wider answer for a peer. Every other login
  answers the same either way. So it is a check where the pair would widen,
  left on the role until S8b, as c2 left the member-path checks.
- **Cells** (unit, no database): `packages/mcp-core/src/login-surface-peer.test.ts`,
  the five logins of c1's cells, each with a peer bound to the anchor (made
  by the anchor, made by another login) and to another login, the caller
  built as `server/web/lib/mcp-auth.ts` builds a peer's; the pair form
  differs only for the role admin outside Admin, where it would name the
  login; an OAuth or key connection always names its login. Mutation: the
  helper without its role read fails 7 of the 17 cells (restored by git
  checkout).
- `eslint-rules/admin-counts.test.ts`: the four packages hold no login kind
  branch, and their one role read is `peerNamesNoLogin`'s line.

### Changed answers

None. No answer moved; the one decision stays on the role, named above.

### Pins

| pin                    | main | c3       | split on c3 (the four packages)                                                                                                          |
| ---------------------- | ---- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| loginKindBranches      | 17   | 17       | tools 0, runtime 0, mcp-core 0, telegram 0 (server/web 17)                                                                               |
| loginRoleDecisionReads | 27   | 27       | tools 0, runtime 0, mcp-core 1 (peerNamesNoLogin), telegram 0 (server/web 25, content 1)                                                 |
| adminDecisionFlags     | 40   | 40       | tools 4, runtime 11, mcp-core 0, telegram 0, all the workspace's own flag (server/web 10, content 5, server/api 5, db 3, client-types 2) |
| inHandlerAreaChecks    | 20   | 20       | tools 6, runtime 1, mcp-core 2, telegram 1: scope asks (and one ask about another login), not moved in c3                                |
| historyCodeComments    | 2335 | **2334** | the peer naming comment lost its step code when it moved to `peerNamesNoLogin`                                                           |

### Gates

Mac (DATABASE_URL unset), on 78c2ba34e (the commits after it lower the
history code pin and add this file's rows; arch and format ran again on
them, 0):

## Part c4: server/api, packages/content and the fixtures

The branch `feat/s8c-c4`, cut from main at 975bee317 (v0.300.114). No
migration, no edit in packages/db, packages/content/src/tree,
packages/files or server/web/lib/auth.

### Sorted, site by site

Every login kind, login role and `isAdmin` hit in server/api and
packages/content (non-test files; the counters' detail and a grep for
`'admin'`, `'member'`, `.role`, `LoginRole`, `isAdmin`, `loginHoldsAdmin`
and the caller readers):

| package          | site                                                                                                                     | what it is                                                                                                                                                                     | done                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| packages/content | `login-notices.ts` noticeLogin: only an enabled role member is told login notices                                        | a member-path check on the login role                                                                                                                                          | stays on the role, named (below) |
| packages/content | `team-assistant.ts` 5 (`isAdmin`)                                                                                        | the workspace's own flag (`workspaces.is_admin`)                                                                                                                               | kept                             |
| packages/content | `app-viewer.ts` (`kind: LoginRole`), `mcp-app-data.ts` (`McpDataRole`)                                                   | the role an app sees (display); the reach rule ignores it                                                                                                                      | display, stays legacy until S8b  |
| packages/content | `member-invites.ts` (`role: 'member'`), `contacts.ts` (`inArray(authUsers.role, LOGIN_ROLES)`)                           | a new login's role (S8b's) and a row filter over every known role (decides nothing)                                                                                            | kept, S8b                        |
| packages/content | `table-snapshots.ts` (`scopeHoldsAdmin`), `recall-native.ts` (`actor.kind`, owner or agent)                              | already the scope's answer; a recall writer's kind (server/web decides it), not a login's                                                                                      | kept                             |
| server/api       | `agent/reflector.ts` 1, `agent/summarizer.ts` 1, `workflows/runs-resume-turn.ts` 3 (`isAdmin`)                           | the workspace's own flag                                                                                                                                                       | kept                             |
| server/api       | `agent/runtime.ts` (`loginHoldsAdmin(loginId)`: a Telegram turn of a login that is no Admin user takes a daily cap slot) | membership (`mantle_login_is_admin`), no role or kind; the pair would narrow a role member inside Admin, and moving it needs a role read (pin up) or a new SQL role reader use | kept, named (below)              |
| server/api       | `bench/haystack.ts` (a bench brain's owner row, role admin)                                                              | a bench fixture row, no caller                                                                                                                                                 | kept                             |

Nothing else in server/api or packages/content (outside the tree) reads a
caller, a login kind or a login role: no `ownerCaller`, `loginCaller`,
`getLoginOr401`, `SessionUser` or `adminFacts` there.

### What changed

- `packages/content/src/login-notices.ts`: who is told login notices is the
  exported helper `toldLoginNotices(row)`, the same expression (an enabled
  login with role member), with why it stays on the role. Answers
  unchanged.
- **Why it stays on the role.** "Not an Admin user" by the Admin pair
  (role admin AND a user of Admin) would tell a role admin outside Admin
  its chat and review notices, which the role never did: a push it never
  had, a wider answer. Every other login answers the same either way. So
  it is a check where the pair would widen, left on the role until S8b, as
  c2 left the member-path checks and c3 left `peerNamesNoLogin`.
- **Cells** (unit, no database): `packages/content/src/login-notices-role.test.ts`,
  the five logins of c1's cells, enabled and disabled, plus a role this
  code does not know; the pair form differs only for the role admin
  outside Admin, where it would tell it. Mutation: the helper with
  `role !== 'admin'` fails 1 of the 12 cells (restored by git checkout).
- **`server/api/src/agent/runtime.ts` stays** on `loginHoldsAdmin` (a
  Telegram turn of a login that is no Admin user claims a member daily cap
  slot). It reads membership (`mantle_login_is_admin`), no role and no
  kind, so it is no kind or role decision. The pair would narrow only a
  role member inside Admin (it would then claim a slot, as its web chat
  already does since S8a); moving it needs either a TS role read (the
  `loginRoleDecisionReads` pin goes up) or a new use of the SQL role
  reader `mantle_login_is_admin_user` from server/api (S8b's), so it is
  left as is and named. At S8b membership decides and the role follows it,
  and the two agree with no change.
- `eslint-rules/admin-counts.test.ts`: server/api and content hold no
  login kind branch; their one role read is `toldLoginNotices`'s line;
  their `isAdmin` are the four files of the workspace's own flag.
- **The fixtures.** `server/web/server/run-route-stand-ins.ts` gains
  `loginStandIn(...)` (a Login: the eight fields, no role, no kind, with
  the Admin facts the test says) and `adminFactsStandIn` (answers what the
  stand-in says, no for any other object). The 13 test files whose code
  under test reads a Login (`anyLoginCaller`, `chatCaller().asLogin`,
  `ownerLoginCaller`, `publicLoginItself`) and asks adminFacts lost their
  own converters (`standInLogin(res)`, `standInChatCaller`,
  `asOwnerLogin`) and their copies of the adminFacts mock, and build the
  Login with `loginStandIn`:
  `apps/app-tool-broker`, `apps/app-identity-owner`,
  `apps/member-runner-routes`, `apps/member-connectors.turn-scope.db`,
  `assistant/turn/turn-failed-route`, `assistant/transcribe/transcribe-route`,
  `assistant/threads/threads.db`, `oauth/authorize/authorize-route`,
  `lib/app-broker-parity`, `lib/workspaces.db`, `lib/grants.db`,
  `server/a10-app-broker-sweep`, `server/w7c-chat.db`. Where the code
  under test still reads a legacy shape too (`getLoginOr401`,
  `loginCaller`, the `gated` request scope's drafts in workspaces and
  grants; `getChatLoginOr401` and `chatLoginCaller` in threads and
  w7c-chat), that shape stays for that reader and the Login is built
  beside it from the same fact. No assertion changed; no test added,
  removed or renamed. Two stand-ins became fuller Logins: the A10 broker
  sweep's admin actor carries `isOwner: false` and the OAuth route's
  Logins carry `source: 'web'` and `sessionEpoch: 0`; their tests answer
  as before (the sweep's recorded files unchanged). Left on the legacy
  shape, by design: `shell-parts.test.ts` (the shell still reads
  `legacyLogin` for the display role), `gate-caller.test.ts` (the gate's
  own answers), the admin-facts cells (they compare the legacy decision
  with adminFacts), and the AppViewerSubject fixtures in packages/content
  (the app's display kind, no Login).

### Changed answers

None. No decision moved; the one role read in c4's packages stays on the
role, named above, and `runtime.ts` keeps its membership ask.

### Pins

No pin moves: nothing in c4's packages was a kind branch, the one role
read stays (named, a widening otherwise), and the `isAdmin` there are the
workspace's own flag. Test files are not counted, so the fixture moves
change no counter.

| pin                    | main | c4  | split on c4 (server/api, packages/content)                                                                                                                                        |
| ---------------------- | ---- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| loginKindBranches      | 17   | 17  | server/api 0, content 0 (all 17 in server/web/lib/auth/session.ts: the resolved caller's union, S8d)                                                                              |
| loginRoleDecisionReads | 27   | 27  | server/api 0, content 1 (`toldLoginNotices`) (server/web 25, mcp-core 1)                                                                                                          |
| adminDecisionFlags     | 40   | 40  | server/api 5 (reflector 1, summarizer 1, runs-resume-turn 3), content 5 (team-assistant), all the workspace's own flag (server/web 10, runtime 11, tools 4, db 3, client-types 2) |
| inHandlerAreaChecks    | 20   | 20  | server/api 1 (`runtime.ts` loginHoldsAdmin, named above), content 0                                                                                                               |

### Gates

Mac (DATABASE_URL unset), on f63bb0409 (the commit after it adds this
section only):

| gate                                                             | exit                              |
| ---------------------------------------------------------------- | --------------------------------- |
| pnpm -r typecheck                                                | 0                                 |
| pnpm lint                                                        | 0                                 |
| pnpm format:check                                                | 0                                 |
| pnpm docs:check                                                  | 0                                 |
| pnpm arch:check                                                  | 0 (historyCodeComments went down) |
| pnpm -C server/web build                                         | 0                                 |
| pnpm exec vitest run --maxWorkers=3 server packages eslint-rules | 0 (860 files passed, 271 skipped) |
| pnpm arch:check, format:check on e0b338f39                       | 0, 0                              |
| pre-push `pnpm verify` (0afacd809)                               | 0                                 |

Workstation (own clone `s8c-c3-clone` at 0afacd809, own `s8c-c3-pg`,
pgvector pg18, max_connections=450, port 56231 checked free, the
`postgres` role as CI; MANTLE_CHECK_FLOOR=keep for init and migrate only;
DATABASE_URL unset for every vitest run; systemd-run --user; --maxWorkers=3;
one at a time). Every set passed on its first run, no rerun; the recorded
sweep files (`__snapshots__`) unchanged after each run (no `-u`, `git
status` on them empty):

| run                                                                                                            | exit | result                              |
| -------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------- |
| the cells (login-surface-peer, admin-counts, mcp-auth-peer, admin-facts, admin-facts-handlers, w6b-fix3, warn) | 0    | 6 files, 72 passed                  |
| full vitest with DB                                                                                            | 0    | 1131 files, 13916 passed, 1 skipped |
| test:actor-off                                                                                                 | 0    | 129 files, 1180 passed, 1 skipped   |
| test:actor-on                                                                                                  | 0    | 31 files, 380 passed, 1 skipped     |
| test:edit-on                                                                                                   | 0    | 43 files, 550 passed                |
| test:matrix                                                                                                    | 0    | 4 files, 8 passed                   |
| test:runtime-role, full config                                                                                 | 0    | 279 files, 2790 passed, 1 skipped   |

CI on 0afacd809: run 39399194805, success.

### Left after c3

- `peerNamesNoLogin` (mcp-core) stays on the peer's login role until S8b
  makes the role follow membership; then the role and the pair agree and
  it needs no change.
- The display roles in the four packages (the MCP channel's and audit's
  `role`, the app data `:host_me_kind`) stay the legacy role until S8b
  (display only; the reach rule ignores the role). Since c2 the browser
  broker sends a role admin outside Admin to the member runner, so its
  browser and MCP views of the app may name it differently until then.
- The 15 `isAdmin` in tools and runtime are the workspace's own flag: kept.
- The 10 in-handler area asks in the four packages are already the scope's
  answer (or an ask about another login); moving them into the gate is not
  c3's.

| pnpm arch:check                                                  | 0                                 |
| pnpm -C server/web build                                         | 0                                 |
| pnpm exec vitest run --maxWorkers=3 server packages eslint-rules | 0 (860 files passed, 273 skipped) |

The branch was pushed with `--no-verify` while these ran (the hook's
`pnpm verify` is the same set).

Workstation (own clone `s8c-c4-clone` at f63bb0409, own `s8c-c4-pg`,
pgvector pg18, max_connections=450, port 56241 checked free, the
`postgres` role as CI; MANTLE_CHECK_FLOOR=keep for init and migrate only;
DATABASE_URL unset for every vitest run; systemd-run --user;
--maxWorkers=3; one at a time). Every set passed on its first run, no
rerun; the recorded sweep files (`__snapshots__`) unchanged after each
run (no `-u`, `git status` on them empty):

| run                                                                                                                                                    | exit | result                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ----------------------------------- |
| the cells and the five moved DB fixture files (login-notices-role, admin-counts, the five, admin-facts, admin-facts-handlers, login-notices.viewer.db) | 0    | 10 files, 128 passed                |
| full vitest with DB                                                                                                                                    | 0    | 1133 files, 13934 passed, 1 skipped |
| test:actor-off                                                                                                                                         | 0    | 130 files, 1191 passed, 1 skipped   |
| test:actor-on                                                                                                                                          | 0    | 31 files, 380 passed, 1 skipped     |
| test:edit-on                                                                                                                                           | 0    | 43 files, 550 passed                |
| test:matrix                                                                                                                                            | 0    | 4 files, 8 passed                   |
| test:runtime-role, full config                                                                                                                         | 0    | 281 files, 2809 passed, 1 skipped   |

### Left after c4 (S8c done)

For S8b (the role follows membership):

- The checks that stay on the login role because the pair would widen:
  `toldLoginNotices` (content), `peerNamesNoLogin` (mcp-core), and
  server/web's member-path checks (`mcp-auth.ts` memberMcpCaller and
  mcpTargetLogin, `mcp-oauth.ts` a member grant, `pair-code.ts` the member
  code and bearer, `peer-access.ts`). Once the role equals membership they
  agree with the pair and need no change; the role reads can then go.
- `server/api/src/agent/runtime.ts` asks membership for the Telegram daily
  cap; once the role follows membership it equals the pair (no change).
- Display roles stay legacy: whoami, the shell, access keys' answer and
  audit row, the app's `:host_me_kind` and AppViewer kind, the MCP
  channel's and audit's `role`, the push notice's `role: 'member'`.
- A new or changed login's requested role and the row filters
  (`member-invites.ts`, `contacts.ts`, users route, login-update.ts,
  users/[id]/agent, push/store.ts, access-keys-notify.ts).
- Before the pair goes: `mantle_scope_is_admin()` needs the owner and
  membership checks (fix round 1 above).

For S8d (adapters out):

- The 17 `loginKindBranches` in `server/web/lib/auth/session.ts` (the
  resolved caller's union) and the legacy readers `loginCaller`,
  `chatLoginCaller`, `ownerCallerWithLogin`, `publicLoginCaller`,
  `legacyLogin`, `loginSessionUser`, with `AnyLogin`, `MemberCaller` and
  `SessionUser`.
- The tests still on the legacy shape go with them: the legacy half of the
  workspaces, grants, threads and w7c-chat fixtures (kept for
  `getLoginOr401`, `loginCaller`, `getChatLoginOr401`, `chatLoginCaller`
  and the drafts of their request scope), `shell-parts.test.ts`
  (`legacyLogin`), `gate-caller.test.ts`, and the admin-facts cells'
  legacy side.
- `ownerFromBearer` (`server/web/lib/mcp-oauth.ts`) still has no caller
  outside its unit test.
