# Route declarations, plan v3.2 S9 (handover)

The route lists folded into one declaration in each route file (plan v3.2
section 2, S9; wave 5, alone: no other lane edits route files while it
runs). Four parts: part 0 builds the tooling without touching a route file
or a list's contents; part 1 runs the codemod; part 2 flips the rows to the
declarations; part 3 deletes the lists. Each part's section: what changed,
the measured numbers, the changed answers, the pins, the gates with their
exit codes, what is left.

## Part 0: the declaration, the loader, the codemod

Branch feat/s9-p0, from main at fe06d3037 (v0.300.132). No route file
(server/web/app/\*\*/route.ts) and no list's contents are edited: the
unmerged feat/s7b-b2 still edits 8 route files (none of the list files),
and the codemod writes all 418, so it runs after b2 merges. No migration.

### What changed

- server/web/lib/auth/route-declaration.ts (new): the declaration's shape,
  next to routeParams in each route file:

  ```ts
  export const policy = routePolicy({
    GET: { class: 'content', effect: 'read', open: 'owner' },
    POST: { class: 'content', effect: 'write', open: 'owner', creates: true },
  });
  ```

  Per method: `class` (public, link, self, area, content), `area` (an area
  row), `effect`, `open` (owner, any, chat, telegram, member; none: Admin
  only), `item` ({ param, need } or { none: reason }), `creates`,
  `keyArea` (an /api/v1 row: an area, null, or 'self' for whoami),
  `limits` ({ crossSite, rateLimit }), `aliasOf`. Three fields beyond the
  plan's list, each because a row needs it to come out equal: `public`
  (a self or area row the gate lets in: sign-in, the version, the
  branding), `scope: null` (a self row no owner guard serves: the
  any-login routes outside every owner prefix) and `makesItems: false`
  (NO_ITEM_WRITES). `routePolicy` is the identity; only names and types,
  so the generator reads the module without loading the app.
- server/web/scripts/route-callers.ts `handlerPolicy`: the generator reads
  the declaration from the code as data (literals only; a name, a call, a
  spread, a computed key, `let`, a re-export, an aliased import or a
  method the file does not export is refused). gen-route-manifest.ts puts
  it in the manifest (`policy`) and now writes each entry's `file`.
- server/web/lib/auth/route-policy.ts: buildRouteRow's derivation is split
  into `listedFacts` (the lists, as before, line for line) and
  `declaredFacts` (a declaration, every value checked at boot: an /s route
  is a link row and only it, an area names an area, `creates` and
  `makesItems: false` only on a write, an item's param is a param of the
  pattern, a key area only on /api/v1 and one of the key areas, an alias
  is the same method of a served base, a limit is a named limit).
  `ROUTE_POLICY_SOURCE = 'lists'` decides which; buildRoutePolicy takes
  `source` too. Under 'declarations' a route file that declares no policy
  for a method it exports is refused at boot; under either a declaration
  for a method it does not serve is. A page of server/pages has no route
  file, so its row stays the lists' in both.
- server/web/server/route-loader.ts: RouteEntry carries `policy`; the
  rows are built from it at registration (buildRoutePolicy). Under
  'declarations' only, the first load of a module checks its `policy`
  export against the manifest's (`checkLoadedPolicy`: a stale manifest
  throws); a module that exports none (a test's stand-in) is not asked.
- server/web/scripts/route-declarations.ts (new) and
  scripts/route-policy-codemod.ts (new): `rowDeclaration` writes a row's
  fields that are not their default; the CLI derives each file's
  declaration from the lists, proves every row built from the
  declarations equal (JSON of the whole row) to the lists' row and that
  the generator reads each new file back to the same declaration, then
  writes. `--check` (the default: report, exit 1 when a file would
  change), `--dry-run [dir]` (the would-be files under dir, a temp dir by
  default), `--write`, `--verbose`. Placement: after the routeParams
  export, else after the last import, else at the end; the import
  of routePolicy after the last import (at the top of a file with none,
  the v1 alias files). Formatted with the repo's prettier config.
  Nothing is written when a row cannot be said or is not equal.
- eslint-rules/route-plumbing.mjs `route-policy-declared`: a route file
  that exports a method declares a policy naming each method it exports
  and no other. `'off'` in eslint.config.mjs until part 1.
- server/web/lib/auth/\_\_snapshots\_\_/route-policy.rows.json (new): every
  row, every field (a field at its default left out; a field not in the
  test's default table is always written), the pin parts 2 and 3 hold
  byte-equal. The plan named this file; it did not exist (only
  route-policy-rows.txt, four fields a row).
- Tests: lib/auth/route-policy-declarations.test.ts (the derived
  declarations build every row equal; a manifest that carries
  declarations carries one per file, each the lists' own, and its rows
  are the lists'; the snapshot; the refusals at boot; the loader check),
  scripts/route-declarations.test.ts (placement, idempotence, the
  generator's read-back and refusals), eslint-rules/route-plumbing.test.ts
  (the rule).

### Measured (main v0.300.132)

`pnpm -C server/web exec tsx scripts/route-policy-codemod.ts --check`:

| | |
|---|---|
| route files | 418 |
| rows (methods served, HEAD included) | 819 |
| declarations the codemod writes (methods declared; a HEAD the GET handler answers takes its GET's) | 572 |
| rows equal to the lists' (field for field) | 819 of 819 |
| rows it cannot say | 0 |

The dry-run tree (a throwaway detached worktree of this branch, removed
after): `--write` wrote 418 files (+2450 lines), a second `--check` wrote
0 (idempotent). On that tree, rows from the lists: route-policy.test.ts,
route-policy-declarations.test.ts (the full manifest comparison ran:
every entry carried its declaration), route-policy-rows.test.ts,
route-callers.test.ts, api-v1.test.ts, route-params.test.ts,
route-loader.test.ts and auth-sweep.test.ts, 125 tests, exit 0. With
`ROUTE_POLICY_SOURCE = 'declarations'` (part 2's flip) the 48 non-database
test files of server/web/server, its middleware, lib/auth, scripts and the
route lists: 362 passed, 23 failed, all of them in 7 files whose tests
build a manifest by hand without declarations (route-policy.test.ts 5,
gate.test.ts, gate-caller.test.ts, gate-login.test.ts,
gate-login-update.test.ts, gate-route.test.ts, item-write-encoded.test.ts),
each failing with "declares no policy": part 2 gives those stand-in
manifests their declarations. Every test over the real manifest passed
under the flip: route-policy.test.ts's "every field answers what its list
answers", the auth, member, role, link-render, A4 guard and A10 sweeps,
served-route.test.ts. tsc, prettier --check on server/web/app and eslint
on server/web/app with `route-policy-declared` set to error: exit 0 (and
418 errors on the tree before the codemod).

### What the lists hold that the declaration does not say

The codemod expresses every row field the lists decide. What stays in a
list after part 3, with why (routePolicyLists counts 15 lists today, the
plan's target is at most 1):

1. PUBLIC_PATHS (auth-constants.ts): the rows' `public` is declared, but
   the gate also answers paths no row serves with it (gate.ts: /login,
   /pair, /app-runtime, /.well-known, the /s pages before routing).
2. AUDIT_SELF_LOGGED_PATHS (auth-constants.ts): which writes skip the
   generic `api.write` audit row. Not a row field; could become one
   (`audit: 'own'`) in part 1.
3. body-limit.ts ceilings: by the decoded path, read by the gate before a
   row is found (gate.ts) and by the loader; per path, not per method.
   Could become `limits.body` if the gate reads the row first.
4. public-session-routes.ts: the session sweep's expectations (status per
   role). A test fixture under server/, so it is counted; not policy.
5. PUBLIC_LOGIN_ROWS (route-policy.ts): which public rows may read a
   login, checked against the caller kind the generator reads from the
   code. Not counted by the plan's fields; could be declared as the
   expected caller (`reads`) and cross-checked.
6. Not counted, also not declared: LINK_CORS_PATTERNS (pattern level: the
   OPTIONS preflight and the 405 answer have no row), isAssetPath,
   RENDER_ASSET_RE, ASSET_V1_PATTERNS and ASSET_QUERY_AS_HANDED (the gate
   reads them on raw paths too), OWNER_AT_READ_ROWS, FRAME_ROWS,
   ADMIN_OPEN_ROWS (its scope half is declared, class self; its caller
   check half is not), NO_LOGIN_LOOKUP_ROWS (session.ts), and the
   api-v1.ts table's `base` (folded into the declared `open` and
   `creates`; the table itself still answers matchApiV1Route).
7. The pages of server/pages (SHARE_PAGES, PRINT_PAGES): no route file;
   their rows stay the lists' until the page lists carry a declaration.

### The guard's area check, folded into the gate's step 5 (planned, not applied)

Today `adminRouteGate` (session.ts, the `cls.kind === 'area'` branch, the
`TODO(A4 exit)` at about line 1840) asks `holdsArea` again for an Admin
login on an area row. The gate's step 5 (packages/db gate.ts `adminStep`)
refuses the same on a row only where `httpCaller` (gate.ts) sets the
caller's `admin`, which is `row.caller === 'owner'` alone. The area rows
today: 354 owner, 2 ownerAsset (GET and HEAD /api/attachments/:id), 8
public (no guard). So the guard's check still answers for three cases:
the asset rows, a login lookup whose area read failed (`admin` null,
resolveHttpLogin's catch), and a request that changed its login since
(`logins.changed`, never true at the gate's own answer).

The diff, for part 2 (after the flip, with S8b's caller work in view):

```diff
--- server/web/server/middleware/gate.ts (httpCaller)
-  const admin = row.caller === 'owner' ? login.admin : null;
+  // Every area row's caller is answered before the handler with the
+  // Admin view (buildRouteRow refuses another kind on an area row).
+  const admin = row.area && ADMIN_STEP_CALLERS.has(row.caller) ? login.admin : null;
--- server/web/lib/auth/session.ts (resolveHttpLogin)
-    } catch {
-      admin = null;
-    }
+    } catch (error) {
+      // Answered in the handler's place, as the guard's second ask threw.
+      throw new RouteLoginError(error);
+    }
   (and, on an asset row, the view of the login a `?at=` token or the
   render cookie names: the same ownerForAsset the asset guard reads)
--- server/web/lib/auth/session.ts (adminRouteGate)
   if (cls.kind === 'area') {
-    // On a row whose handler reads the pipeline's caller the gate's step 5
-    // refused a login without the area already (A4 step 3b part 4); this
-    // is the guard's own check, for the rows that still call it.
-    // TODO(A4 exit): folds into the gate's step 5 when the last guard goes.
-    if (!(await holdsArea(loginId, cls.area))) {
-      return accessRefusal(new AccessError('area', undefined, { area: cls.area }));
-    }
+    // The gate's step 5 refused a login without the row's area.
     noteRequestSystem('area');
     return null;
   }
-  (holdsArea, its one caller gone)
--- server/web/lib/auth/route-policy.ts (buildRouteRow)
+  ADMIN_STEP_CALLERS = new Set(['owner', 'ownerAsset']); an area row whose
+  caller is neither (and is not public) is refused at boot.
```

Proof before it merges: the A4 guard sweep and narrow-area-routes.db.test.ts
over every area row, for an Admin user with the area, without it, a member,
an `?at=` token of an Admin user without connectors on
/api/attachments/:id, and a failed area read: every answer byte-equal to
main's.

### Changed answers

None. Every row is the lists' (route-policy.test.ts, the new full-row
snapshot); the declarations are read only where ROUTE_POLICY_SOURCE says
'declarations', and nothing declares one on this branch.

### Pins

- routePolicyLists stays 15 (the brief: it stays tonight).
- historyCodeComments stays 2333: S9 joins HEADING_CODES_LEFT_OUT
  (eslint-rules/cleanup-counts.mjs) with its reason, as D1 did: its label
  is also finding S9 of an earlier audit (packages/files, "audit S9"), and
  no counted comment of this branch names the step.

### Gates

On the Mac, DATABASE_URL unset, on the branch's head:

- `pnpm -r typecheck`: 0
- `pnpm lint`: 0 (one warning, an unused eslint-disable in
  contact-sharing-routes.db.test.ts, as on main)
- `pnpm format:check`: 0
- `pnpm docs:check`: 0
- `pnpm arch:check`: 0 (routePolicyLists 15, historyCodeComments 2333)
- `pnpm -C server/web build`: 0
- `pnpm exec vitest run server packages eslint-rules`: 0 (876 files
  passed, 285 skipped: the database files, which need the workstation)

No database test was needed: no SQL, no migration, and every row is held
by tests that build the rows without one. The database suites (the
workstation lanes) are the merge gate on a fresh clone of the pushed
commit, per the standing rule.

### Left (parts 1 to 3)

1. Part 1, once feat/s7b-b2 has merged and route files are frozen for the
   wave: the codemod's `--check` (`pnpm -C server/web exec tsx
   scripts/route-policy-codemod.ts`; expect 819 of 819 equal, a moved
   count names the merged routes), then `--write`,
   `route-policy-declared` to 'warn'. Decide the
   five lists of the section above (audit, body ceilings, the caller
   check) before the codemod runs, if they are to be declared.
2. Part 2: give the hand-built test manifests their declarations (the 7
   files above), flip ROUTE_POLICY_SOURCE, `route-policy-declared` to
   'error', and the area check fold above.
3. Part 3: delete the lists (route-scope.ts sets, any-login-routes.ts,
   member-routes.ts, ROUTE_GATES, the key table's policy half), the
   `listedFacts` path and `source`; rows held to route-policy.rows.json.

## Part 0 round 2: the shape settled before part 1 writes it

The audit of part 0 (8/10, merge after fixes; no change in 'lists' mode)
asked for the declaration's shape to settle before the codemod writes
418 files once. Still tooling only: no route file and no list's
contents edited, ROUTE_POLICY_SOURCE stays 'lists'.

### What changed, per round 2 input

- M1: `routePolicy(d: RoutePolicyDeclaration): RoutePolicyDeclaration`,
  not generic, so an excess key is a type error in a method, an item and
  the limits alike (lib/auth/route-declaration.test.ts holds each refused
  shape as a `@ts-expect-error` that tsc checks). An item is
  `{ param, need }` or `{ none }`, exclusively (each says the other's keys
  are `never`). At run time the policy, the item, the limits and an
  effect exception are exact key sets; null, an array or a non-object
  is refused with what it is.
- M2: the effect is derived from the method (GET and HEAD read, every
  other method writes, as isReadRequest). A declaration states only an
  exception, `effect: { read: why }` on a write method or
  `effect: { write: why }` on a GET or HEAD; a plain `effect` string, an
  exception that is the method's own effect, or one with no reason is
  refused. The three: POST /api/formulas/:id/evaluate (read), the two
  OAuth callback GETs (write).
- M3: one source. An alias (`aliasOf`) declares no `open`, `creates` or
  `limits`: they are its base's declaration's (open projected: 'owner'
  or none), as the lists' alias took them. A v1 row with a handler of
  its own that admits a login as a base route does declares `base`
  (was api-v1.ts `base`) and no `open` or `creates`; its limits are its
  own handler's. The boot finds the base's declaration in the manifest
  (served and declared, the same method, a route off /api/v1) and
  refuses one that is not. 25 aliases, 2 base rows.
- M4: one pure validator, `validateMethodPolicy(raw, pattern, method)`
  and `validateRoutePolicy(raw, pattern, methods)` in
  route-declaration.ts. The generator (route-callers.ts handlerPolicy,
  at pretypecheck) and the boot (route-policy.ts declaredFacts) both run
  it; what needs the whole manifest (an alias's base, the caller the
  code reads) and the rate limits' names (route-limits.ts; the type
  refuses an unknown name too) stay the boot's. The shape is const
  arrays there (DECLARED_METHODS, DECLARED_KEYS, DECLARED_CLASSES,
  DECLARED_OPEN, ITEM_NEEDS, ITEM_KEYS, LIMIT_KEYS, CROSS_SITE,
  NAMED_CALLERS, EFFECT_KEYS, READ_METHODS); a compile-time check pins
  DECLARED_KEYS to the type's keys. The generator's and route-callers'
  method lists are DECLARED_METHODS; handlerPolicy takes the methods
  from the manifest entry (`exportedMethods`) instead of reading its own.
  The lint (eslint-rules/route-plumbing.mjs) imports DECLARED_METHODS and
  ROUTE_POLICY_EXPORT from route-declaration.ts: Node 26 loads the
  TypeScript file as it is, which is why that file imports only the
  client types' name lists at run time.
- L1: `checkLoadedPolicy` throws where the manifest carries a policy and
  the module exports none; a test's stand-in routes opt out by name
  (registerRoutes' `{ standIn: true }`). A test loads every route module
  of the manifest and asks it (route-policy-declarations.test.ts).
- L2: the generator reads a declaration into objects with no prototype
  and refuses a `__proto__` key; the validator refuses one wherever it
  is, and reads with Object.hasOwn.
- L3: the codemod builds, proves and reads back every file's text
  first, then writes them all (none on a failure).
- The owner's list decisions:
  - AUDIT_SELF_LOGGED_PATHS: a field, `audit: 'own'`, per method, only
    on a row that audits as a write (auditsAsWrite). The row gains
    `audit` ('own' or null): the lists' row says it from the path list
    (11 rows). session.ts auditMutation still asks isAuditSelfLogged of
    the path (no change in 'lists' mode); part 2 reads `row.audit`
    there. A test proves the row's answer is the path's for every path
    each pattern spells, every param tried with every segment a listed
    path holds.
  - PUBLIC_LOGIN_ROWS, OWNER_AT_READ_ROWS, ADMIN_OPEN_ROWS and
    FRAME_ROWS (their caller half): one field, `caller`, the named
    caller kind the row reads (NAMED_CALLERS: publicLogin 7,
    cookieUpgrade 1, ownerAtRead 2, session 1, frame 1). Checked both
    ways at boot against the caller the generator reads from the code:
    a declared kind the handler does not read is refused, and so is a
    named kind the row does not declare (callerServes). ADMIN_OPEN_ROWS'
    scope half is the declared class 'self'. One field for the four,
    as they are one rule: a kind read only on a row named for it.
    FRAME_ROWS keeps feeding session.ts NO_LOGIN_LOOKUP_ROWS (a kept
    list; it names two patterns, one of which reads the frame caller).
  - PUBLIC_PATHS stays a list. Its shrink to the unrouted paths changes
    the lists' rows, so it is part 3's; the list it shrinks to is pinned
    now: `/login` and `/app-runtime`, the entries no manifest pattern
    is under (a param counts as any segment). A route under one of
    them fails that test first. Body ceilings, LINK_CORS_PATTERNS, the
    asset lists, NO_LOGIN_LOOKUP_ROWS and the page lists stay lists.
  - public-session-routes.ts leaves the policy count
    (arch-counts.mjs ROUTE_LISTS_NOT_POLICY, with why):
    routePolicyLists 15 to 14.
- The item decision: `item` is required on every write in the type and
  at boot, refused on a read. The codemod writes `{ none: why }` where
  the row has no item check (every write today: itemWriteTarget reads
  none), the reason from the row's facts (a public, link, self or area
  row; a create with no path param; a write with no path param), else
  ITEM_NONE_PLACEHOLDER, one fixed string the lint can forbid later.

### Measured (the branch, main v0.300.132 under it)

| | |
|---|---|
| route files | 418 |
| rows | 819 |
| declarations (methods declared) | 572 |
| writes with `item: { none }` | 326 |
| of them, the placeholder reason | 81 |
| rows equal to the lists' (field for field, `audit` included) | 819 of 819 |

The rows snapshot (route-policy.rows.json) changes by the `audit` field
alone, on 11 rows: every other field of every row is what it was.

### The dry run and the flip (a throwaway detached worktree of 39bda9d51)

- `--write`: 418 files written (+3466 lines); a second `--check`: 819 of
  819 equal, 0 files to write (idempotent).
- On the written tree, lists mode: tsc 0, prettier on server/web/app 0,
  eslint on server/web/app with `route-policy-declared` at 'error' 0
  errors (the rule fires on an unwritten file). The full vitest suite:
  876 files passed, 1 failed (the per-file route list pin of
  public-session-routes.ts, fixed on the branch after that commit),
  285 skipped (the database files). The manifest carried every
  declaration, so route-policy-declarations.test.ts ran its full
  comparison (each the lists' own, the rows the lists'), and the L1 test
  loaded all 418 modules and found each export the manifest's.
- With `ROUTE_POLICY_SOURCE = 'declarations'` (part 2's flip), the full
  suite: 25 failed. One is the pin above. One is served-route.test.ts,
  whose stand-in modules over the real rows export no policy: L1
  refuses them, as it should, and registerRoutes' `standInModules`
  (added for it) clears it (rerun: passes). The other 23 are the 7
  files whose tests build a manifest by hand without declarations, each
  "declares no policy": gate.test.ts 19 tests and route-policy.test.ts
  4, while gate-caller, gate-login, gate-login-update, gate-route and
  item-write-encoded fail as files (their setup builds the rows). The
  same 23 as round 1. Every test over the real manifest passed under the flip.

### Pins

- routePolicyLists 15 to 14 (public-session-routes.ts is test data), and
  its per-file pin (no-policy-name-lists.mjs ROUTE_LIST_PINS) drops it.
- historyCodeComments stays 2333.
- The stand-in escape pin (arch-lints.test.ts) now names
  `standInModules` too: route-policy.ts and route-loader.ts only.

### Left (parts 1 to 3), as round 2 leaves it

1. Part 1, after feat/s7b-b2 merges: `--check` (expect 819 of 819 and 81
   placeholders; a moved count names the merged routes), `--write`,
   `route-policy-declared` to 'warn'.
2. Part 2: declarations for the 7 hand-built test manifests,
   `standInModules` in served-route.test.ts, the flip, the rule to
   'error', session.ts auditMutation reading `row.audit`, and the area
   check fold.
3. Part 3: delete the lists and `listedFacts`; PUBLIC_PATHS shrinks to
   `/login` and `/app-runtime` (renamed for the unrouted paths); FRAME_ROWS
   leaves route-policy.ts, NO_LOGIN_LOOKUP_ROWS keeps its own two
   patterns; api-v1.ts keeps its matching half.
4. Each ITEM_NONE_PLACEHOLDER (81) is decided (a check or a reason);
   then the lint forbids the string.

## Part 0 round 3: the item reasons, the aliases, one checked copy

The re-audit of round 2 (8.5/10, merge after fixes; 'lists' mode proven
identical by running main against the branch) left one medium, three low
and two informational inputs. Still tooling only: no route file and no
list's contents edited, ROUTE_POLICY_SOURCE stays 'lists'.

### What changed, per round 3 input

- MED-1, the 'self' item reason: scripts/route-declarations.ts
  itemNoneReason gave every 'self' write "the login's own things, not an
  item", and 24 of them name another party's thing in the path (a grant,
  a workspace's member or resource, an assistant thread or turn, a
  Telegram chat of the workspace). Now the 'self' reason is written only
  for a write with no path param, except under `/api/grants/` (the grant
  move and its preview name items in the body, BODY_NAMES_ITEMS), and for
  five named own things, each with its own reason (OWN_THINGS: an access
  key, the owner's and a login's push device, a login's MCP client, a
  login's Telegram chat; each handler finds the thing by the login or the
  owner). Every other 'self' write takes ITEM_NONE_PLACEHOLDER: 19 with a
  param and the 2 grant moves. A test holds each OWN_THINGS pattern to a
  'self' write the manifest serves.
- LOW-1, the alias is the route re-exported: route-callers.ts
  `reExportedHandlers` reads the methods a route file takes unchanged
  from another module (`export { GET } from`, `export { GET as HEAD }
from`, an imported handler exported by name; a wrapper is not one), and
  `aliasMismatches` holds each declared `aliasOf` to the route file the
  handler comes from (its pattern, the same method): the generator
  (gen-route-manifest.ts) and the codemod refuse a mismatch, an alias
  declared on a handler of its own, and a re-exported route handler with
  no alias. route-policy.test.ts holds the lists' alias to the same
  resolved `from` path, where it held only that some re-export existed.
  The boot refuses a declared `base` that API_V1_ROUTES does not name,
  while that table names the bases.
- LOW-2: route-declaration.ts exports UNAUDITED_METHODS (the reads and
  OPTIONS) and `auditsByMethod`; route-scope.ts auditsAsWrite and
  isReadRequest read them and READ_METHODS (through methodEffect), and
  the validator's `audit` check is the same function. No answer moves.
- LOW-3: validateMethodPolicy copies the value first (dataCopy: no
  prototype at any level, arrays too, frozen; each value read once),
  checks the copy and returns it; validateRoutePolicy returns an object of
  those copies. declaredFacts builds a row from the copy only, and reads
  an alias's base from the base's own checked copy, not the module's
  value. A test with a getter that answers differently on a second read
  finds it read once.
- INFO, the no-login rows: session.ts NO_LOGIN_LOOKUP_ROWS is gone; the
  gate asks route-policy.ts `findsNoLogin(row)`, the frame caller: in
  'lists' mode FRAME_ROWS by pattern, as before; in 'declarations' mode
  `row.caller === 'frame'` (callerServes already holds the declared and
  the read kind to one). A test finds the two answers equal on every row
  of the manifest (GET and HEAD /api/apps/:id/frame, nothing else).
- INFO, effect reasons per route: each effect exception's reason is its
  own route's (the formula calculator; the MCP connector's and the
  Microsoft connector's OAuth callbacks), and a listed exception with no
  reason written is one the codemod cannot say.
- LOW-4 (merge note, not done here): when feat/s7b-b2 lands, keep both
  histories in scripts/arch-scoreboard.pins.json `routePolicyLists` and
  in eslint-rules/no-policy-name-lists.mjs ROUTE_LIST_PINS's comment, the
  number 14.

### Measured (the branch at the round 3 fix, main v0.300.132 under it)

| | |
|---|---|
| route files | 418 |
| rows | 819 |
| declarations (methods declared) | 572 |
| aliases (`aliasOf`) / v1 rows with a `base` | 25 / 2 |
| writes with `item: { none }` | 326 |
| of them, the placeholder reason | 102 (was 81) |
| rows equal to the lists' (field for field, `audit` included) | 819 of 819 |
| main's rows against the branch's, 'lists' mode | 819 of 819, every field of main's equal; the branch adds `audit` (11 rows) |

### The dry run and the flip (a throwaway detached worktree)

- main first (fe06d3037): the manifest generated and every row dumped;
  then the same worktree at the branch's round 3 commit: the rows equal,
  as the table says.
- `--write`: 418 files written (+3498 lines); a second `--check` (which
  regenerates the manifest, so the generator's alias check ran on all 25
  aliases): 819 of 819 equal, 102 placeholders, 0 files to write. One
  alias pointed at another served, declared route (`GET /api/pages` in
  the v1 notes file): the generator refused it, naming the route the
  file re-exports; the boot alone would have taken it.
- On the written tree, 'lists' mode: tsc 0, prettier on server/web/app 0,
  eslint on server/web/app with `route-policy-declared` at 'error' 0
  errors (the one warning is an unused disable in a database test, as in
  round 2). The full vitest suite, DATABASE_URL unset: 877 files passed,
  285 skipped (the database files), 0 failed.
- With `ROUTE_POLICY_SOURCE = 'declarations'`: 24 failed, the same tests
  as round 2 less the pin it fixed: served-route.test.ts (its stand-in
  modules want `standInModules`) and the 7 files whose tests build a
  manifest by hand without declarations (gate.test.ts 19,
  route-policy.test.ts 4 and its gate describe, gate-caller, gate-login,
  gate-login-update, gate-route, item-write-encoded). The new tests (the
  alias resolution, the no-login rows) passed under the flip.

### Left (parts 1 to 3), as round 3 leaves it

1. Part 1, after feat/s7b-b2 merges (LOW-4 above): `--check` (expect 819
   of 819 and 102 placeholders; a moved count names the merged routes),
   `--write`, `route-policy-declared` to 'warn'.
2. Part 2: as round 2 says (the hand-built test manifests,
   `standInModules` in served-route.test.ts, the flip, the rule to
   'error', `row.audit` in auditMutation, the area check fold).
3. Part 3: as round 2 says; FRAME_ROWS goes with the lists, and
   `findsNoLogin` keeps its declarations half.
4. Each of the 102 placeholders is decided (a check or a reason), then
   the lint forbids the string. The 21 'self' ones first: they are the
   writes whose path or body names another party's thing.

## Part 0 round 4: the own things, the effect exceptions, the aliases, one resolver

The re-audit of round 3 (8.5/10, merge after fixes; 'lists' mode proven
identical again, 5908 method-set cases equal) left one medium residual,
five low inputs and one informational one. Still tooling only: no route
file and no list's contents edited, ROUTE_POLICY_SOURCE stays 'lists'.

### What changed, per round 4 input

- MED-1 residual, the login's own things: three of round 3's five
  OWN_THINGS reach past the login in their handlers, so the path's param
  is not only the login's own: `/api/access-keys/:id` (an Admin user
  revokes any login's key), `/api/telegram/my-chats/:id` (a Moderator or a
  users-area Admin acts on another login's chat) and
  `/api/push/subscriptions/:id` (an Admin user deletes a member's device
  by its owner id). They leave OWN_THINGS
  (scripts/route-declarations.ts) and take ITEM_NONE_PLACEHOLDER. The two
  that stay were read again: `/api/member/push/subscriptions/:id`
  (loginPushUnpair deletes by the member's login id and the id, else 404)
  and `/api/member/mcp/clients/:id` (disconnectLoginClient by the member's
  anchor and login, else 404). The test that held the opposite
  (route-declarations.test.ts, the 'self' reason test) now holds the three
  to the placeholder and pins OWN_THINGS to the two.
- LOW-A, the key area at boot: route-policy.ts declaredFacts holds a
  declared `keyArea` to api-v1.ts API_V1_ROUTES while that table exists,
  as `base` is held: a v1 row the table names declares its area (or
  'self', for whoami), the same one, and a row it does not name declares
  none. Refused otherwise, at boot.
- LOW-B, the effect exception: a read is stated only on a POST, a write
  only on a GET or HEAD. The type (route-declaration.ts: a POST's policy
  may carry `effect: { read }`, a PUT, PATCH, DELETE or OPTIONS's may not)
  and validateMethodPolicy both refuse the rest (`READS_BY_EXCEPTION`).
  A test pins the lists' own exceptions (route-scope.ts READ_POSTS and
  WRITE_GETS) to the same: each a POST, each a GET.
- LOW-C, an alias is its base's row: declaredFacts refuses an alias whose
  class, area, effect or item (the param and need, or the `none` reason)
  is not its base's. Its open, creates and limits it may not declare at
  all (round 2), so each field the handler decides is the base's.
- LOW-D, a route file named by a path that is not relative: refused.
  `@/app/.../route` (or any spec whose last segment is `route`, or an `@/`
  path to a route file) throws in route-callers.ts specRouteFile, so the
  generator fails on it wherever it follows a route file (the handlers'
  reads, the switches, the alias check), and aliasMismatches reports it
  for the codemod. No route file names another so today.
- LOW-E, one resolver: route-callers.ts `routeDirSegments` (a route
  directory's segments, the generator's own spelling, moved there),
  `routeFilePattern`, `specRouteFile` and `specPattern` (a `from` spec of
  a route file to the route pattern it names). The generator, the codemod
  and route-policy.test.ts each call specPattern; the codemod's own
  manifest map and the test's own resolve are gone.
- INFO, the caller from the checked copy: buildRoutePolicy reads each
  route's declaration once (validateRoutePolicy) into its checked copy, and
  every row of the route, its HEAD and an alias's base are built from that
  copy. buildRouteRow holds the declared named caller to the handler's
  from the copy (RowFacts `declaredCaller`), never from the module's
  value. A test with a getter that answers differently on a second read
  builds both rows from the first answer.

### Measured (the branch at the round 4 fix, main v0.300.132 under it)

| | |
|---|---|
| route files | 418 |
| rows | 819 |
| declarations (methods declared) | 572 |
| writes with `item: { none }` | 326 |
| of them, the placeholder reason | 105 (was 102) |
| rows equal to the lists' (field for field, `audit` included) | 819 of 819 |
| main's rows against the branch's, 'lists' mode | 819 of 819, every field of main's equal; the branch adds `audit` (11 rows) |

### The dry run (a throwaway detached worktree)

- main first (fe06d3037): the manifest generated and every row dumped;
  then the same worktree at the branch's round 4 head: the rows equal, as
  the table says.
- `--check`: 819 of 819 equal, 105 placeholders, 418 files to write.
  `--write`: 418 files written (+3498 lines). A second `--check` (which
  regenerates the manifest, so the generator's alias check and the one
  resolver ran on all 25 aliases): 819 of 819, 105 placeholders, 0 files
  to write.
- On the written tree, 'lists' mode: tsc 0, prettier on server/web/app 0,
  eslint on server/web/app with `route-policy-declared` at 'error' 0
  errors (the one warning is the unused disable in a database test, as
  before). The full vitest suite, DATABASE_URL unset: 877 files passed,
  285 skipped (the database files), 0 failed. So the new boot holds (the
  key area to the table, an alias to its base) passed over every row of
  the real written manifest: route-policy-declarations.test.ts builds them
  in 'declarations' mode from it.
- With `ROUTE_POLICY_SOURCE = 'declarations'`: 24 failed, the same tests
  as round 3: served-route.test.ts (its stand-in modules want
  `standInModules`) and the 7 files whose tests build a manifest by hand
  without declarations (gate.test.ts 19, route-policy.test.ts 4 and its
  gate describe, gate-caller, gate-login, gate-login-update, gate-route,
  item-write-encoded). The round 4 tests passed under the flip.

### Gates

On the Mac, DATABASE_URL unset, all on the one head that carries this
section:

- `pnpm -r typecheck`: 0
- `pnpm lint`: 0 (the one warning, the unused eslint-disable in
  contact-sharing-routes.db.test.ts, as on main)
- `pnpm format:check`: 0
- `pnpm docs:check`: 0
- `pnpm arch:check`: 0 (routePolicyLists 14, historyCodeComments 2333:
  the round 4 code says what each check holds, not the round it came from)
- `pnpm -C server/web build`: 0
- `vitest run` (the whole suite): 0 (877 files passed, 285 skipped: the
  database files, which need the workstation)

No database test was needed: no SQL, no migration. The database suites
(the workstation lanes) are the merge gate on a fresh clone of the pushed
commit, per the standing rule.

### Left (parts 1 to 3), as round 4 leaves it

1. Part 1, after feat/s7b-b2 merges (round 3's LOW-4 merge note stands:
   keep both histories in scripts/arch-scoreboard.pins.json
   `routePolicyLists` and in no-policy-name-lists.mjs ROUTE_LIST_PINS,
   the number 14): `--check` (expect 819 of 819 and 105 placeholders; a
   moved count names the merged routes), `--write`, `route-policy-declared`
   to 'warn'.
2. Part 2: as round 2 says (the hand-built test manifests,
   `standInModules` in served-route.test.ts, the flip, the rule to
   'error', `row.audit` in auditMutation, the area check fold).
3. Part 3: as round 3 says. When API_V1_ROUTES leaves the policy (its
   matching half stays), the boot's holds of `base` and `keyArea` to it go
   with it, and the declarations are the one source.
4. Each of the 105 placeholders is decided (a check or a reason), then
   the lint forbids the string. The 24 'self' ones first: the writes whose
   path or body names another party's thing, the three of round 4 among
   them.

## Part 0 rebase: onto main, and an alias held to its base in every key

The re-audit of round 4 (9/10, merge after the narrow-route work lands)
left one low input for part 1 and a merge note. That work (S7b parts b2
and b3) is on main (v0.300.135, f6f6dad47), so the branch is rebased onto
it. Still tooling only: no route file and no list's contents edited,
ROUTE_POLICY_SOURCE stays 'lists'.

### The rebase

16 commits replayed, authorship kept. Two conflicts, both the expected
merge note:

- scripts/arch-scoreboard.pins.json `routePolicyLists`: the value 14
  (main's 15, less public-session-routes.ts, which part 0 round 2 took out
  of the count). The note keeps both histories: this branch's 15 to 14
  first, then main's 16 to 15 (the narrow area sweep's LOGIN_SELF_ROWS
  gone, its entries from the route table) and main's 15 to 16 before it.
  `historyCodeComments` is main's (2347): the branch moves it by none,
  so nothing re-pinned.
- eslint-rules/no-policy-name-lists.mjs ROUTE_LIST_PINS comment: both
  histories, main's LOGIN_SELF_ROWS paragraph and then this branch's
  public-session-routes.ts one. The pins themselves merged clean.

Main added no route file and edited no list file the codemod reads (its
auth change is session.ts only), so the numbers did not move: 418 route
files, 819 rows (the connector-options route was already under the
branch).

### What changed after the rebase

- The alias held to its base in every key: route-policy.ts
  declaredFacts compared an alias with its base in class, area, effect and
  item only. It now walks DECLARED_KEYS: each key but the alias's own
  (route-declaration.ts `ALIAS_OWN`: `aliasOf` and `keyArea`) and the ones
  read from the base (`ALIAS_COPIES`: open, creates, limits, refused on an
  alias as before) must say what the base's says, declared on both or on
  neither: so makesItems, audit, public, scope and caller are held too,
  and a key added to the shape later is held by default. The effect is
  compared as the row's (the method's or the stated exception), the item
  as its param and need or its `none` reason, as before. The cell
  (route-policy-declarations.test.ts, "an alias says every key its base
  declares") refuses each held key one at a time and checks that its list
  of keys is DECLARED_KEYS less ALIAS_OWN and ALIAS_COPIES, so a new key
  needs a cell. In 'lists' mode no alias row differs from its base's in
  any of these (42 alias rows, HEAD included, compared field by field),
  so the codemod's output passes the new hold.

### Measured (the branch on main v0.300.135)

| | |
|---|---|
| route files | 418 |
| rows | 819 |
| declarations (methods declared) | 572 |
| writes with `item: { none }` | 326 |
| of them, the placeholder reason | 105 |
| aliases written | 25 files |
| rows equal to the lists' (field for field, `audit` included) | 819 of 819 |
| main's rows against the branch's, 'lists' mode | 819 of 819, every field of main's equal; the branch adds `audit` (11 rows) |

### The dry run (a throwaway detached worktree)

- main first (f6f6dad47): the manifest generated and every row dumped;
  the branch's rows (after the rebase) compared with them, as the table
  says.
- The same worktree at the alias fix's head (055a04def): `--check` 819 of
  819 equal, 105 placeholders, 418 files to write; `--write` 418 files
  (+3498 lines); a second `--check` 819 of 819, 105 placeholders, 0 files
  to write.
- On the written tree, 'lists' mode: tsc 0, prettier on server/web/app 0,
  eslint on server/web/app with `route-policy-declared` at 'error' 0
  errors (the one warning, the unused disable in a database test, as
  before). The S9 tests (route-declaration, route-policy-declarations,
  route-policy, route-declarations, route-plumbing, arch-lints,
  route-loader, served-route): 8 files, 168 tests passed. So the new hold
  ran over every alias of the real written manifest:
  route-policy-declarations.test.ts builds every row in 'declarations'
  mode from it.
- The full vitest suite on the written tree, 'lists' mode, DATABASE_URL
  unset: 888 files passed, 304 skipped (the database files), 0 failed.
- The throwaway worktree was removed by its exact path.

### Gates

On the Mac, DATABASE_URL unset, on 73ec8db99 (the alias fix and this
section's first part; the commit after it adds only these lines):

- `pnpm -r typecheck`: 0
- `pnpm lint`: 0 (the one warning, the unused eslint-disable in
  contact-sharing-routes.db.test.ts, as on main)
- `pnpm format:check`: 0
- `pnpm docs:check`: 0
- `pnpm arch:check`: 0 (routePolicyLists 14, historyCodeComments 2347,
  main's)
- `pnpm -C server/web build`: 0
- `vitest run` (the whole suite): 0 (888 files passed, 304 skipped: the
  database files, which need the workstation)

No SQL and no migration, so no database test was needed here; the
database suites (the workstation lanes) are the merge gate on a fresh
clone of the pushed commit, per the standing rule.

### Left (parts 1 to 3), as the rebase leaves it

1. Merge (the CEO's): feat/s9-p0 onto main, ff-only.
2. Part 1: `--check` (819 of 819 and 105 placeholders today; a moved
   count names the routes merged since), `--write`,
   `route-policy-declared` to 'warn'.
3. Part 2: as round 2 says (the hand-built test manifests,
   `standInModules` in served-route.test.ts, the flip, the rule to
   'error', `row.audit` in auditMutation, the area check fold), with the
   round 4 audit's notes: one effect-to-read/write helper in
   route-policy.ts (declaredFacts computes it twice), v1Base reading
   v1Route's GET-for-HEAD lookup, and one reader of a route file's
   exported methods (today the regex, the lint's AST and
   reExportedHandlers).
4. Part 3: as round 3 says.
5. Each of the 105 placeholders decided (a check or a reason), then the
   lint forbids the string; the 24 'self' ones first.

## S9 part 1: every route file declares its policy

Branch feat/s9-p1, from origin/main at 9da71efd7 (v0.300.139: S9 part 0
merged in v0.300.137, S8b in v0.300.139). Wave 5 freeze: no other lane
edits route files or the list files while S9 runs. No migration, no SQL.
ROUTE_POLICY_SOURCE stays 'lists': every row is still built from the
lists, so no answer moves.

### S8b's routes in the codemod's inputs (input 1)

S8b changed four route files (the Users list and item routes, the
personal assistant's admin test, the token refresh) and no list file the
codemod reads. Its methods and rows did not move: `--check` on the branch
before any write gave the part 0 numbers again (table below). The dry
run on a throwaway detached worktree of 9da71efd7: `--write` 418 files
(+3498 lines), a second `--check` 819 of 819 equal and 0 files to write,
and the S9 tests on the written tree (route-declaration,
route-policy-declarations, route-policy, route-policy-rows, route-scope,
route-callers, route-declarations, route-plumbing, arch-lints,
route-loader, served-route: 11 files, 239 tests) exit 0. The worktree was
removed by its exact path.

### What changed

- The codemod's output, one mechanical commit (32769a123, no hand edit):
  `scripts/route-policy-codemod.ts --write` on the branch. Each of the 418
  route files gains `export const policy = routePolicy({ ... })` after its
  routeParams export (else after its last import) and the import of
  routePolicy. 418 files, +3498 lines, nothing else.
- Input 3, the proof: route-policy.test.ts ("S9 part 1: every route file
  declares, and its declarations build the lists' rows") finds no manifest
  entry without a declaration and every row built from the declarations
  (buildRoutePolicy, source 'declarations') equal, field for field, to the
  lists' row. route-policy-declarations.test.ts no longer takes "none" as
  an answer (part 0's branch for a manifest with no declarations is gone),
  holds every manifest declaration to the one the lists say, and holds the
  declarations' rows to `__snapshots__/route-policy.rows.json` as the
  lists' rows are held (the same file, unchanged). Its L1 test loads all
  418 route modules and runs checkLoadedPolicy (source 'declarations') on
  each: every module exports the declaration its manifest entry read.
- Input 4, missing declaration fails lint and boot:
  `mantle-plumbing/route-policy-declared` is 'error' (eslint.config.mjs).
  The boot: route-policy.ts `requireRouteDeclarations(manifest)`, called
  by createApp (server/app.ts) before registerRoutes, whatever the source:
  a route file that exports a method it declares no policy for is named
  and the app does not start; each declaration is held by
  validateRoutePolicy there too. A test's hand-built manifest is not asked
  (it goes through registerRoutes, not createApp). The boot smoke
  (server/main.ts) now runs checkLoadedPolicy (source 'declarations') on
  each route module it loads, so a stale manifest fails the smoke.
- Input 5, the placeholders: kept as the one fixed string
  (ITEM_NONE_PLACEHOLDER, route-declaration.ts), per the owner's decision.
  A new counter, `itemNonePlaceholders` (eslint-rules/arch-counts.mjs
  `itemNonePlaceholderCount`, a unit test in arch-lints.test.ts), pinned
  at 105 in scripts/arch-scoreboard.pins.json with its note: it may only go
  down; S11b gives each a check or a reason, then the lint forbids the
  string.
- docs/actors.md section 10 and 12: a route file declares its policy.

### Measured (the branch on main v0.300.139)

| | |
|---|---|
| route files written | 418 |
| rows (methods served, HEAD included) | 819 |
| declarations (methods declared) | 572 |
| rows equal to the lists' (field for field, `audit` included) | 819 of 819 |
| writes with `item: { none }` | 326 |
| of them, the placeholder reason | 105, in 82 route files (pinned, `itemNonePlaceholders` 105) |
| aliases (`aliasOf`) | 25, in 18 files |
| `audit: 'own'` | 11 |
| effect exceptions | 3 (one read on a POST, two writes on GETs) |
| route files with no declaration | 0 |

### Changed answers

None. The rows are the lists' (ROUTE_POLICY_SOURCE 'lists'); the
declarations build the same rows and the snapshot did not change. The boot
check refuses only a manifest with an undeclared method, which the
generated one is not.

### Pins

- `itemNonePlaceholders` new, 105 (only down).
- routePolicyLists stays 14 (part 3 deletes the lists).
- docs/actors.md stays under its 350-line cap (348).
