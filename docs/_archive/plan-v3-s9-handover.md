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

|                                                                                                    |            |
| -------------------------------------------------------------------------------------------------- | ---------- |
| route files                                                                                        | 418        |
| rows (methods served, HEAD included)                                                               | 819        |
| declarations the codemod writes (methods declared; a HEAD the GET handler answers takes its GET's) | 572        |
| rows equal to the lists' (field for field)                                                         | 819 of 819 |
| rows it cannot say                                                                                 | 0          |

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

|                                                              |            |
| ------------------------------------------------------------ | ---------- |
| route files                                                  | 418        |
| rows                                                         | 819        |
| declarations (methods declared)                              | 572        |
| writes with `item: { none }`                                 | 326        |
| of them, the placeholder reason                              | 81         |
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

|                                                              |                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| route files                                                  | 418                                                                        |
| rows                                                         | 819                                                                        |
| declarations (methods declared)                              | 572                                                                        |
| aliases (`aliasOf`) / v1 rows with a `base`                  | 25 / 2                                                                     |
| writes with `item: { none }`                                 | 326                                                                        |
| of them, the placeholder reason                              | 102 (was 81)                                                               |
| rows equal to the lists' (field for field, `audit` included) | 819 of 819                                                                 |
| main's rows against the branch's, 'lists' mode               | 819 of 819, every field of main's equal; the branch adds `audit` (11 rows) |

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

|                                                              |                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| route files                                                  | 418                                                                        |
| rows                                                         | 819                                                                        |
| declarations (methods declared)                              | 572                                                                        |
| writes with `item: { none }`                                 | 326                                                                        |
| of them, the placeholder reason                              | 105 (was 102)                                                              |
| rows equal to the lists' (field for field, `audit` included) | 819 of 819                                                                 |
| main's rows against the branch's, 'lists' mode               | 819 of 819, every field of main's equal; the branch adds `audit` (11 rows) |

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

|                                                              |                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| route files                                                  | 418                                                                        |
| rows                                                         | 819                                                                        |
| declarations (methods declared)                              | 572                                                                        |
| writes with `item: { none }`                                 | 326                                                                        |
| of them, the placeholder reason                              | 105                                                                        |
| aliases written                                              | 25 files                                                                   |
| rows equal to the lists' (field for field, `audit` included) | 819 of 819                                                                 |
| main's rows against the branch's, 'lists' mode               | 819 of 819, every field of main's equal; the branch adds `audit` (11 rows) |

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

### The users routes in the codemod's inputs (input 1)

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

|                                                              |                                                             |
| ------------------------------------------------------------ | ----------------------------------------------------------- |
| route files written                                          | 418                                                         |
| rows (methods served, HEAD included)                         | 819                                                         |
| declarations (methods declared)                              | 572                                                         |
| rows equal to the lists' (field for field, `audit` included) | 819 of 819                                                  |
| writes with `item: { none }`                                 | 326                                                         |
| of them, the placeholder reason                              | 105, in 82 route files (pinned, `itemNonePlaceholders` 105) |
| aliases (`aliasOf`)                                          | 25, in 18 files                                             |
| `audit: 'own'`                                               | 11                                                          |
| effect exceptions                                            | 3 (one read on a POST, two writes on GETs)                  |
| route files with no declaration                              | 0                                                           |

### Changed answers

None. The rows are the lists' (ROUTE_POLICY_SOURCE 'lists'); the
declarations build the same rows and the snapshot did not change. The boot
check refuses only a manifest with an undeclared method, which the
generated one is not.

### Pins

- `itemNonePlaceholders` new, 105 (only down).
- routePolicyLists stays 14 (part 3 deletes the lists).
- docs/actors.md stays at 344 lines (section 10's row bullet says the
  declaration in the same four lines).

### Gates

All on 17e3ffcab (the commit after it adds only this section and the
next).

On the Mac, DATABASE_URL unset:

| gate                                      | exit                                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm -r typecheck`                       | 0                                                                                                                 |
| `pnpm lint`                               | 0 (the one warning, the unused eslint-disable in contact-sharing-routes.db.test.ts, as on main)                   |
| `pnpm format:check`                       | 0                                                                                                                 |
| `pnpm docs:check`                         | 0                                                                                                                 |
| `pnpm arch:check`                         | 0 (itemNonePlaceholders 105, routePolicyLists 14)                                                                 |
| `pnpm boot:smoke`                         | 0 (14 services link; the web entry loads all 418 route modules and holds each one's policy to its manifest entry) |
| `pnpm -C server/web build`                | 0                                                                                                                 |
| `vitest run server packages eslint-rules` | 0 (891 files passed, 305 skipped: the database files)                                                             |

On the workstation, a fresh clone of the pushed commit per suite, each on
its own throwaway pgvector pg18 container (a free port checked, fsync
off, removed by its exact name after), MANTLE_NARROW_SYSTEM=1,
--maxWorkers=3:

| suite             | exit      | files                                                                                                         |
| ----------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| vitest shard 1/2  | 0         | 598 passed                                                                                                    |
| vitest shard 2/2  | 1, then 0 | the first run: a6b-exit-sweep.db.test.ts, 2 tests (see below); the rerun of the whole shard alone: 598 passed |
| test:actor-off    | 0         | 169                                                                                                           |
| test:actor-on     | 0         | 34                                                                                                            |
| test:edit-on      | 0         | 46                                                                                                            |
| test:runtime-role | 0         | 317                                                                                                           |
| test:matrix       | 0         | 4                                                                                                             |
| test:serial       | 0         | 1                                                                                                             |

The shard 2 failure was a timeout, and what it left behind (corrected in
part 2, the audit's L5): the A6b exit sweep's rule-in-query section timed
out under the default test budget while all eight suites ran at once (load
average 13 to 17), its body kept running, and one of its owner turns'
statements (an INSERT on nodes, "no Moderator of the home") landed as a
miss row in the next section, narrow-reads. Rerun alone the file passed (8
of 8), and the whole shard, rerun alone, passed (8017 of 8017). Part 2
gives rule-in-query 60s and makes a section that starts while another is
still running fail with that name (see "S9 part 2", L6).

### Left (parts 2 and 3)

1. Part 2: the hand-built test manifests' declarations (gate.test.ts,
   route-policy.test.ts's gate describe, gate-caller, gate-login,
   gate-login-update, gate-route, item-write-encoded),
   `standInModules` in served-route.test.ts, the flip of
   ROUTE_POLICY_SOURCE, session.ts auditMutation reading `row.audit`, the
   area check fold (part 0's planned diff), and the round 4 audit's notes
   (one effect helper in route-policy.ts, v1Base on v1Route's GET-for-HEAD
   lookup, one reader of a route file's exported methods).
2. Part 3: delete the lists and `listedFacts`, as round 3 says; the rows
   held to route-policy.rows.json.
3. S11b: each of the 105 placeholders becomes an item check or a reason
   (`itemNonePlaceholders` goes down with each), then the lint forbids the
   string.

## S9 part 2: the rows read from the declarations, the area check in the gate

Branch feat/s9-p2, from origin/main at 84bc6026c (v0.300.140, part 1
merged). Wave 5 freeze: no other lane edits route files or the lists. No
migration, no SQL. The lists stay in place (part 3 deletes them), and a
test still holds every declaration to what the lists say.

### What changed, per input

1. The hand-built test manifests declare. server/web/server/test-support.ts
   `withRealPolicies` gives a test's entry on a pattern the app serves the
   app's own declaration for the methods it serves (a named caller the
   stand-in does not read is left out, so its row is the one the lists
   built for it); `withRealBases` adds the served base of a v1 row for a
   test of the rows alone; `standInPolicy` and `standInDeclared` declare the
   loader's own routes (public, a write naming no item). gate.test.ts,
   gate-caller, gate-login, gate-login-update, gate-route,
   item-write-encoded, route-policy.test.ts (its gate describe and its
   direct buildRoutePolicy calls), route-loader.test.ts,
   route-params.test.ts and serve-listener.test.ts use them;
   served-route.test.ts passes `standInModules`. requireRouteDeclarations
   moved into registerRoutes: every caller's manifest is asked (the app's
   boot and every test), fail closed; createApp's own call went.
2. The flip: ROUTE_POLICY_SOURCE = 'declarations'. The lists stay; the
   S9 part 1 tests still hold each declaration to the lists' answer and
   every row to route-policy.rows.json (unchanged).
3. session.ts auditMutation reads the row's `audit` ('own' skips the
   generic api.write row), not AUDIT_SELF_LOGGED_PATHS by the path.
4. The area check fold, part 0's planned diff with one addition:
   - gate.ts httpCaller: `admin` is the login's view on every area row
     whose caller is one of route-policy.ts ADMIN_STEP_CALLERS (owner,
     ownerAsset); buildRouteRow refuses at boot an area row that is not
     public and reads another kind (a cell in route-policy.test.ts; the
     app's area rows are 354 owner, 2 ownerAsset, 8 public).
   - session.ts resolveHttpLogin: the view is read for the login the
     row's guard answers as: the request's Admin login, or on the asset
     rows the login getOwnerForAsset answers as, in its order (the
     session, an `?at=` token, the render cookie; assetViewLogin, the same
     kept finds, no effect). A read that fails throws RouteLoginError;
     the gate middleware answers it in the handler's place (onError, the
     CORS headers kept), so no handler runs and nothing asks the area
     again.
   - session.ts adminRouteGate: the guard's own `holdsArea` (a second
     requireArea) is gone. The addition: the guard reads the gate's view
     (gateHeldArea) and refuses fail closed where the view does not answer
     (another login than the view's, a login the request changed since,
     no view). In the app the guard runs only as the gate's answer, before
     any handler, so this never refuses there; it keeps the stand-in
     test's answer for a guard read after the request changed a login.
5. Round 4 audit notes: one effect helper (route-policy.ts declaredEffect,
   a row's and an alias base's); one v1 lookup (api-v1.ts apiV1RouteOf,
   HEAD as GET, read by route-policy.ts and the codemod's v1Base); one
   reader of a route file's methods (route-callers.ts exportedMethods, TS
   syntax, used by gen-route-manifest.ts in place of its regex; the
   generated manifest is byte for byte main's). route-plumbing.test.ts
   holds the lint's reading of each export form to it, which found one
   drift: the lint counted `export type { PUT }` as a method; it no longer
   does.
6. The part 1 audit's LOWs:
   - L1, for S11b: the placeholder's text is false for many of the 111;
     most become `{ param: 'id', need }` matching the check their handler
     already makes (the pages draft's assertItemRight, for one).
   - L2: the six content writes that name an existing item in their body
     take the placeholder (scripts/route-declarations.ts
     BODY_ITEM_WRITES: DELETE /api/files/files, POST /api/shares, POST
     /api/shares/contacts, POST /api/entities/merge, POST
     /api/entities/dismiss, POST /api/apps/import). The codemod wrote the
     six files (+24, -6). Left as "names no item in its path", read and
     judged not body-item writes: POST /api/journal, /api/v1/journal,
     /api/contacts, /api/apps/import-package, /api/formulas/seed (each
     makes a new item) and PUT /api/app-nav/pins (the login's own pin
     list).
   - L3: route-policy-declared reports a policy not written out where it
     is exported (a name, another call's argument, an export clause, a
     re-export: `notLiteral`).
   - L4: arch-counts.mjs's orphaned JSDoc is back on routePolicyLists.
   - L5: part 1's flake text above, corrected.
   - L6: a6b-exit-sweep: rule-in-query has 60s, and a section that starts
     while another section's body still runs (its test timed out) fails
     naming it and the misses it left.

### Measured (the branch on main v0.300.140)

|                                                                  |                                                |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| route files                                                      | 418                                            |
| rows                                                             | 819                                            |
| rows from the declarations equal to the lists' (field for field) | 819 of 819                                     |
| rows equal to route-policy.rows.json                             | 819 of 819 (the file unchanged)                |
| declarations (methods declared)                                  | 572                                            |
| `item: { none }` placeholders                                    | 111 in 88 files (was 105 in 82; the six of L2) |
| codemod `--check` after the L2 write                             | 819 of 819, 111 placeholders, 0 files to write |

### The answers, recorded on main first

- The guard sweeps (non-DB, committed snapshots): a4-guard-sweep (all
  eight files), role, auth, member, link-render, the A10 sweeps: pass on
  the branch with every file under server/web/server/**snapshots** and
  route-policy.rows.json byte for byte main's (git diff empty).
- The area cells (new, server/web/lib/auth/s9-area-fold.db.test.ts): 74
  cells, recorded on main's code (84bc6026c with only the test file and
  the actor-on config laid over, the workstation) in warn and on; the two
  records are equal. A sample of area rows (one or more of each area,
  reads and writes) for an Admin user with the area, one without any, a
  member and no credential; the asset row (GET and HEAD
  /api/attachments/:id) for the session, an `?at=` token and the render
  cookie of each; a failed area read, every ask and only the first.
- The A6b exit sweep, the w6a route sweep, a4-head-logins,
  admin-membership and the matrix ran on main (exit 0 each) and run on
  the branch against the same committed records.
- The narrow area sweep's report (MANTLE_SWEEP_REPORT) on main and on the
  branch: 292 rows, every status and body equal (ids and stamps out).

### Changed answers

Every one stricter, none looser:

1. A failed area read on an area row (requireArea throws once, then
   answers): main asked again in the guard and answered the row (200 on
   GET /api/keys and GET /api/users for the Admin user, the handler's 404
   on the attachment, 403 'area' on GET /api/keys for the no-area Admin);
   the branch answers the opaque 500 in the handler's place, the CORS
   headers kept, no handler run. Cells: `GET /api/keys fail:once cookie`
   (two cells of that name: the Admin user and the no-area Admin), `GET
/api/users fail:once cookie`, `GET attachment fail:once cookie`
   (CHANGED in the test, each named). An area read that fails every time:
   500 on main and on the branch.
2. A guard read after the request changed a login, on an area row: main
   asked requireArea again; the branch refuses from the gate's view. The
   answer of the one cell (gate-login.test.ts, "an Admin login whose area
   is taken away") is the same 403 'area'; the area is asked once, not
   twice. No route reaches this in the app.

Unchanged by the fold: the asset rows. Main's guard asked the area of the
`?at=` token's login (GET 403 'area' for the no-area Admin, 404 past the
gate for the Admin user, HEAD 401 for any token); the gate's step 5 now
holds the same login's view, and every asset cell is main's.

### Pins

- `itemNonePlaceholders` 105 to 111: the six body-item writes (L2),
  with the note in scripts/arch-scoreboard.pins.json. Only down from here.
- `historyCodeComments` 2345 to 2342: three comment lines that named a
  step code went with the code they described.
- routePolicyLists stays 14 (part 3).

### Gates

Mac, DATABASE_URL unset, on 8e7f2619f (the commits after it change only
the area cells' normaliser and this file):

| gate                                      | exit                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm -r typecheck`                       | 0                                                                                        |
| `pnpm lint`                               | 0 (the one warning, the unused disable in contact-sharing-routes.db.test.ts, as on main) |
| `pnpm format:check`                       | 0                                                                                        |
| `pnpm docs:check`                         | 0                                                                                        |
| `pnpm arch:check`                         | 0                                                                                        |
| `pnpm boot:smoke`                         | 0 (14 services link)                                                                     |
| `pnpm -C server/web build`                | 0                                                                                        |
| `vitest run server packages eslint-rules` | 0 (891 files passed, 306 skipped)                                                        |

Workstation, a fresh clone of the pushed commit per suite, own pgvector
pg18 container on a checked free port, fsync off, MANTLE_NARROW_SYSTEM=1
(off: 0), --maxWorkers=3; ~/s9p2:

Suites on 8e7f2619f (the full set) and f21054a9b (reruns):

| suite                                     | exit      | files                 | what failed                                                                                     |
| ----------------------------------------- | --------- | --------------------- | ----------------------------------------------------------------------------------------------- |
| vitest shard 1/2                          | 1         | 598 of 599            | the area cells' record (the tailnet peers, below)                                               |
| vitest shard 2/2                          | 1         | 597 of 598            | gate-caller.test.ts, "a device token is stamped once" (below)                                   |
| test:actor-off                            | 0         | 169                   |                                                                                                 |
| test:actor-on                             | 1, then 0 | 35 of 35 on f21054a9b | the area cells' normaliser (fixed in f21054a9b)                                                 |
| test:edit-on                              | 1, then 0 | 47 of 47 on f21054a9b | the cells' normaliser; edit-check.test.ts timed out once (load average 20), passed on the rerun |
| test:runtime-role                         | 1         | 317 of 318            | the area cells' record (the tailnet peers)                                                      |
| test:serial                               | 0         | 1                     |                                                                                                 |
| test:matrix                               | 0         | 4                     |                                                                                                 |
| switch off (MANTLE_NARROW_SYSTEM=0), full | 1         | 1195 of 1197          | the area cells' record; gate-caller.test.ts (the device token cell, and one timeout under load) |
| narrow area sweep, report                 | 0         | 1                     | (twice: the report compared above)                                                              |

The area cells' record failed only on `GET /api/ai-workers/config`: its
body lists the box's tailnet peers, which the workstation answered with
nine names on the main run and none on the branch run (the environment,
not an answer). The cells now read that field as `<env>` and the two
records were rewritten the same way (no machine name on the record); not
rerun after that change.

The narrow sweep's report: on the branch, two runs, every status and body
of the 292 rows main's; only `wrote` moved, on a different row each run
(PUT /api/profile/reminder-channel on the first; POST /api/skills, PUT
/api/tools/:id/external-access, POST /api/updates/check on the second):
the generic audit row is written fire and forget, and lands in the next
row's capture under load. Read as noise of the capture, not an answer.

### Open (read before merge)

1. gate-caller.test.ts, "a device token is stamped once, by the
   pipeline": an Admin user's device token on GET /api/users got 403
   where 200 is expected, in shard 2 and in the switch-off run on the
   workstation; it passes on the Mac every time (the file alone with the
   switch on and off, and the full vitest run). Not seen on main. The
   suspect is the fold's fail-closed read (session.ts gateHeldArea): if
   anything in the device token's answer marks the request's logins
   changed (a token rotation under the box's timing), the guard now
   refuses from the view where main asked requireArea again and passed.
   That would be a stricter answer that is wrong (a false 403), so it
   blocks the merge until it is understood. Two ways out: find what
   forgets the logins on that path, or let gateHeldArea ask the area
   again where the logins changed (main's answer, the planned diff's
   "drop the second ask" kept for every other read). Rerun the file alone
   on the workstation first (`~/s9p2/run.sh <sha>
t=server/web/server/middleware/gate-caller.test.ts`; the rerun
   launched for this did not start).
2. The cells' record of 650dda29c to f21054a9b (pushed) carries the
   workstation's tailnet machine names in
   server/web/lib/auth/**snapshots**/s9-area-fold.{warn,on}.txt; the head
   removes them, the history does not. Squash those commits, or rewrite
   the branch before the merge, so main never holds them.
3. Rerun on the head: shard 1, runtime-role, switch off (the area cells
   with `<env>`), and the area cells alone in warn and on.

### Left (part 3)

Delete the lists (route-scope.ts sets, any-login-routes.ts,
member-routes.ts, ROUTE_GATES, AUDIT_SELF_LOGGED_PATHS, PUBLIC_LOGIN_ROWS,
OWNER_AT_READ_ROWS, FRAME_ROWS, ADMIN_OPEN_ROWS, the key table's policy
half), `listedFacts`, `source` and the test helpers' list paths
(route-policy.test.ts's lists comparisons); rows held to
route-policy.rows.json. S11b: the 111 placeholders (L1 above).

## S9 part 2 round 2: the guard asks again, the device token cell, the gates on one head

Branch feat/s9-p2, the squashed part 2 (a66f1662d) rebased onto origin/main
b29463850 (v0.300.143). The rebase met no conflict: the branch does not
touch server/web/lib/route-limits.ts or the A10 sweep files, so main's app
limits (perLogin `appLimit`, `explain`, the changed sweep records) are on the
branch as main has them. Pushed with a lease over a66f1662d. Part 2's three open items are
answered here: the device token cell (sections 1 and 2), the machine
names (the history was squashed before this round; every record now
carries `<env>`, section 5) and the reruns on the head (section 7). One
commit per
change from here:

| commit    | change                                                                   |
| --------- | ------------------------------------------------------------------------ |
| 786f01eb9 | part 2, rebased (the squash, unchanged)                                  |
| a9fa49f1b | the ruling: the guard asks the area again where the view does not answer |
| cf04c0d4d | gate-caller.test.ts reads the area once in its setup (the cause below)   |
| 31d8293ce | the device token cells in s9-area-fold.db.test.ts                        |
| 415dae579 | the cells' records, written on main v0.300.143                           |

### 1. The CEO ruling, applied

session.ts `guardHoldsArea` replaces part 2's fail-closed read. The guard
reads the gate's Admin view (the one resolveHttpLogin read and step 5 held
the row to) where it answers: the same login (`httpAdminFor`) and no login
changed since. Everywhere else (another login than the view's, a login the
request changed, no view on a test's stand-in route) it asks the area again
(loginHoldsArea), as main's guard did. A view mismatch is never a refusal of
its own. Fail closed stays only for a failed area read: the gate's (the
opaque 500 in the handler's place, RouteLoginError) and the guard's own ask
(it throws, a 500, as on main).

gate-login.test.ts, "an Admin login whose area is taken away, its role
kept: the guard asks again (L-a)", is main's cell again: 403 'area', and
the area asked twice (the gate's question and the guard's). Part 2's
changed answer 2 is gone: that read answers as main did.

### 2. The device token cell: the cause

Nothing marks the logins changed on the device token path. The 403 was
not the guard's: on that cell the guard was never reached. It was the
gate's step 5, refusing on a view that said no, and the view said no
because the area read ran the real requireArea in place of the test's
mock.

- gate-caller.test.ts mocks `../../lib/workspaces` (requireArea answers
  yes for every login but the no-area one). The area read (session.ts
  loginHoldsArea) imports that module dynamically on its use. Instrumented
  (a line per read: the answer and the function it called), the failing
  run's area reads called the real requireArea, whose statements read the
  test's stubbed database (no rows) and answer no; step 5 refused 403
  'area' for the Admin user's device token on GET /api/users.
- It happens only when two first imports of the module are in flight at
  once. A test runs alone, so that needs a test that timed out still
  sending requests beside the next one. On the workstation the file's
  first three tests timed out at 15 s in the shard (17 s, 15 s and 16 s:
  the first pays the cold imports, 4 s alone on the box; the next two ran
  beside its requests under the load), and the device token test ran
  while their requests went on.
- Reproduced on the Mac by making those tests time out
  (`--testTimeout=700`, and 500): the device token cell fails with the same
  403 on the branch AND on main (main's line 1125, `expected 403 to be
200`), the real requireArea in the log of both. So it is the test
  harness under load, not the fold: main's file has the same hole and the
  box's timing found it on the branch's run first.
- The fix (cf04c0d4d): the file's beforeAll makes one area read through
  the pipeline, alone, before any test. That resolves the mocked module
  first (and pays the cold imports in the hook's 60 s, not in a test's
  15 s). With it the file passes at `--testTimeout` 60, 120, 200, 500 and
  700 on the Mac (before: 4 failed at 500 and 700). Importing the module
  from the test itself instead made it worse (every area read got the real
  module), so the warm-up goes through the same path as the requests.

The production path has no mock: the dynamic import is the one module.

### 3. The new cells

s9-area-fold.db.test.ts, "a device token on area rows": an Admin user's
device token (a live mobile_tokens row per login, epoch 0) on GET
/api/users, GET /api/keys and GET /api/agents, for the Admin user with the
area, the one with every area off, and a member: 9 cells.

| cell                          | answer (main and branch) |
| ----------------------------- | ------------------------ |
| GET /api/users bearer:adm     | 200, the users list      |
| GET /api/users bearer:noArea  | 403 'area' (users)       |
| GET /api/users bearer:mem     | 403 'member-login'       |
| GET /api/keys bearer:adm      | 200, the keys list       |
| GET /api/keys bearer:noArea   | 403 'area' (keys)        |
| GET /api/keys bearer:mem      | 403 'member-login'       |
| GET /api/agents bearer:adm    | 200, `{"agents":[]}`     |
| GET /api/agents bearer:noArea | 403 'area' (assistants)  |
| GET /api/agents bearer:mem    | 403 'member-login'       |

The file runs in every lane named in the round 2 inputs: both shards (the
switch on), the full run with the switch off, test:runtime-role, the full
run with the runtime role off (MANTLE_DB_RUNTIME_ROLE=0), and
test:actor-on (the 'on' record).

### 4. Rows

The codemod's `--check` on 415dae579: 418 route files, 819 rows, 572
declarations, 819 of 819 equal, 111 placeholders, 0 files to write.
route-policy.rows.json and every file under server/web/server/**snapshots**
byte for byte main's (git diff against origin/main empty).

### 5. The area records, main against the branch

Written with S9_AREA_RECORD=1 on the workstation, each in its own fresh
clone and cluster: main b29463850 with only the branch's test file and
actor-on config laid over, and the branch at 415dae579, in five lanes each.

| lane (the same on main and the branch)      | main exit | branch exit | lines | branch against main                       |
| ------------------------------------------- | --------- | ----------- | ----- | ----------------------------------------- |
| full run file, warn, switch on              | 0         | 0           | 83    | 79 equal, the 4 `fail:once` lines (named) |
| test:actor-on, on                           | 0         | 0           | 83    | 79 equal, the 4 `fail:once` lines (named) |
| switch off (MANTLE_NARROW_SYSTEM=0), warn   | 0         | 0           | 83    | 79 equal, the 4 `fail:once` lines (named) |
| runtime role off (MANTLE_DB_RUNTIME_ROLE=0) | 0         | 0           | 83    | 79 equal, the 4 `fail:once` lines (named) |
| test:runtime-role, warn                     | 0         | 0           | 83    | 79 equal, the 4 `fail:once` lines (named) |

Main's four warn-mode records (switch on, switch off, runtime role off,
test:runtime-role) are byte for byte one another; so are the branch's.
The 4 lines, main then branch: `GET /api/keys fail:once cookie` 200 then
500 (the Admin user), `GET /api/users fail:once cookie` 200 then 500, `GET
attachment fail:once cookie` 404 then 500, `GET /api/keys fail:once
cookie` 403 'area' then 500 (the no-area Admin). The 9 device token lines
are equal in every lane: GET /api/users by the Admin user's device token
answers 200 on main and on the branch, switch on and off, runtime role on
and off.

The records hold no machine name: the one environment field
(`tailnetPeers` in GET /api/ai-workers/config) reads `<env>`, the emails
`<email>`, ids and stamps out; the only address left is the test anchor's
`test-anchor@example.invalid`. The committed records (83 lines, warn and
on) are main's: the first 74 lines are part 2's record unchanged, the 9
device token lines added.

### 6. Changed answers (the branch against main, final)

One, stricter, on the cells of three names:

1. An area read that fails once (requireArea throws on the first ask,
   then answers): main asked again in the guard and answered the row (200
   on GET /api/keys and GET /api/users for the Admin user, the handler's
   404 on the attachment, 403 'area' on GET /api/keys for the no-area
   Admin); the branch answers the opaque 500 in the handler's place, the
   CORS headers kept, no handler run. Cells: `GET /api/keys fail:once
cookie` (two cells of that name: the Admin user and the no-area Admin),
   `GET /api/users fail:once cookie`, `GET attachment fail:once cookie`.

No other answer moved: the device token cells, the asset rows, the sample
of area rows, the guard sweeps and the narrow rows are main's. Part 2's
changed answer 2 (a guard read after the request changed a login) is
main's again (section 1).

### 7. Gates, on 415dae579

Mac, DATABASE_URL unset:

| gate                                      | exit                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm -r typecheck`                       | 0                                                                                        |
| `pnpm lint`                               | 0 (the one warning, the unused disable in contact-sharing-routes.db.test.ts, as on main) |
| `pnpm format:check`                       | 0                                                                                        |
| `pnpm docs:check`                         | 0                                                                                        |
| `pnpm arch:check`                         | 0                                                                                        |
| `pnpm boot:smoke`                         | 0 (14 services link)                                                                     |
| `pnpm -C server/web build`                | 0                                                                                        |
| `vitest run server packages eslint-rules` | 0 (891 files passed, 306 skipped)                                                        |

Workstation, a fresh clone of the pushed 415dae579 per suite, own
pgvector pg18 container on a checked free port (removed by exact name at
the end), fsync off, MANTLE_NARROW_SYSTEM=1 unless named, --maxWorkers=3;
~/s9p2 (`TAG=r2 run.sh`, rec-main.sh, rec-branch.sh). The box's load
average reached 27 while the set ran.

| suite                                     | exit     | files        | what failed                                                                                               |
| ----------------------------------------- | -------- | ------------ | --------------------------------------------------------------------------------------------------------- |
| vitest shard 1/2                          | 0        | 599          |                                                                                                           |
| vitest shard 2/2                          | 1        | 597 of 598   | eslint-rules/process-entries.test.ts timed out (27.5 s, load); rerun alone: 0. gate-caller.test.ts passed |
| test:actor-off                            | 0        | 169          |                                                                                                           |
| test:actor-on                             | 0        | 35           |                                                                                                           |
| test:edit-on                              | 0        | 47           |                                                                                                           |
| test:runtime-role                         | 0        | 318          |                                                                                                           |
| test:serial                               | 0        | 1            |                                                                                                           |
| test:matrix                               | 0        | 4            |                                                                                                           |
| switch off (MANTLE_NARROW_SYSTEM=0), full | 1        | 1196 of 1197 | a4-guard-sweep.test.ts: two extra 429 rows in its first pass (below); rerun alone with the switch off: 0  |
| runtime role off, full                    | 0        | 1197         |                                                                                                           |
| the area records, main and branch         | 0 (each) | 1 (each)     | section 5: equal but the 4 named lines                                                                    |

gate-caller.test.ts passed in every full run (shard 2: 24 tests in 23 s
under the load, none timed out; the switch off and the runtime role off
runs too).

The guard sweep's two rows: the first pass (on the real clock, 34.5 s
under the load) met two 429 `rate_limited` answers where its record has
none (cells a135 and a139 of the received table; the rest shifted by
two). The rate limits are in the process's memory, so no other test file
can take from them; the second pass stands the clock still for this
reason, the first does not. Not seen in any other run of this or the
last round, nor alone (the switch off, exit 0); read as a window the
slow run met, not an answer. Not proven.

### Left

- CEO full audit (the flip and the fold).
- Part 3 as written in part 2's "Left".
- The local pre-squash branch s9-p2-presquash-local holds the old records
  with the machine names: never pushed; delete it after the merge.

## S9 part 3: the lists deleted, the declarations the one source

Branch feat/s9-p3, from origin/main d3b6e9281 (v0.300.145, part 2
merged). Wave 5 freeze. No migration, no SQL. The Present branch (the
other session's) is not on main, so no rebase; the dev-brain task the brief named
(cfa8b8fa) is the client's Peers screen merge, not Present. Handed over at
about 120 tool calls, before the workstation lanes (see "Left").

| commit    | change                                                                   |
| --------- | ------------------------------------------------------------------------ |
| 60e0d0541 | the sweeps choose their routes off the rows (test-support.ts rowAnswers) |
| c7ff2820b | the lists, listedFacts, the source switch and the codemod deleted        |
| 351f9f4ef | the p2 audit's area LOWs (L1, L2, L4) and the A8 tool-cell time ceiling  |

### 1. The lists deleted

| list                                                                                                                 | where                   | now                                                                 |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------- |
| ROUTE_PREFIXES, routeClass                                                                                           | route-scope.ts          | a declaration's `class` and `area`                                  |
| MEMBER_OPEN_READS, MEMBER_OPEN_WRITES, memberMayRead, memberMayWrite, WORKSPACE_ITEM_PREFIXES                        | route-scope.ts          | `open: 'owner'`; a test holds the kind registry's item routes to it |
| CREATE_ROUTES                                                                                                        | route-scope.ts          | `creates`                                                           |
| READ_POSTS, WRITE_GETS, isReadRequest                                                                                | route-scope.ts          | the effect exception (`effect: { read }`, `{ write }`)              |
| NO_ITEM_WRITES, itemWriteTarget                                                                                      | route-scope.ts          | `makesItems: false`, `item`                                         |
| ANY_LOGIN_ROUTES, CHAT_LOGIN_ROUTES, TELEGRAM_LOGIN_ROUTES, isAnyLoginRoute, isChatLoginRoute (the file)             | any-login-routes.ts     | `open: 'any'`, `'chat'`, `'telegram'`                               |
| MEMBER_ROUTES, isMemberRoute (the file)                                                                              | member-routes.ts        | `open: 'member'`                                                    |
| ROUTE_GATES                                                                                                          | route-limits.ts         | `limits` (the RouteGates type stays)                                |
| API_V1_ROUTES, apiV1RouteOf, matchApiV1Route, ApiV1Route                                                             | api-v1.ts               | `keyArea`, `base`, `aliasOf` (KeyRoute is its own type now)         |
| AUDIT_SELF_LOGGED_PATHS, isAuditSelfLogged                                                                           | auth-constants.ts       | `audit: 'own'`                                                      |
| PUBLIC_LOGIN_ROWS, OWNER_AT_READ_ROWS, ADMIN_OPEN_ROWS, FRAME_ROWS, loginsOf, aliasOf, v1BaseOf, rowScope, listNamed | route-policy.ts         | `caller` (the named kinds), `aliasOf`, `base`                       |
| listedFacts, RoutePolicySource, ROUTE_POLICY_SOURCE, checkLoadedPolicy's and buildRoutePolicy's `source`             | route-policy.ts, loader | declaredFacts only; a page's row is pageFacts'                      |
| route-policy-codemod.ts, route-declarations.ts and its test                                                          | server/web/scripts      | gone (no second source left); its generator cells kept (below)      |

The boot's holds of a declared `base` and `keyArea` to the key table went
with the table: the declaration is the one source of both (the validator
still holds `keyArea` and `base` to /api/v1, and an alias's base to the
route its file re-exports). A v1 row that declares no key area is not in
the API (keyOnRow: not-in-api), as a v1 path the table did not list was.

A page of server/pages has no route file and so no declaration:
buildRouteRow gives its row `pageFacts` (no scope, a link row under /s, its
`public` from PUBLIC_PATHS, the method's effect, no list, item, key, limit
or audit), the values listedFacts gave it. A render page under /s or /api
is refused (it would shadow a declared route). buildRouteRow with neither
a page nor a declaration throws ("declares no policy").

The generator's cells of the codemod's test (handlerPolicy, the alias
resolution) are server/web/scripts/route-callers-policy.test.ts now.

### 2. The lists kept, and why

| list                                                                          | where                              | why                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PUBLIC_PATHS, isPublicPath                                                    | auth-constants.ts                  | the gate's answer for a request no row answers, or a path that does not spell its row's pattern (gate.ts gateRouteView). Kept whole, not shrunk: a shrink would turn an unrouted /api/auth/... or an escaped /s spelling from 404 into 401 (an answer change). The one counted list. |
| isAssetPath, isRenderAssetPath, ASSET_V1_PATTERNS, ASSET_QUERY_AS_HANDED      | auth-constants.ts, route-policy.ts | the gate reads them on the raw path (an `?at=` token's admission, the render cookie) as well as the rows; assetRow reads them                                                                                                                                                        |
| LINK_CORS_PATTERNS, linkCors                                                  | route-policy.ts                    | a preflight (OPTIONS) and the 405 answer of an /s route have no row                                                                                                                                                                                                                  |
| SHARE_PAGES, PRINT_PAGES                                                      | server/pages                       | no route file: the page list is the page's class                                                                                                                                                                                                                                     |
| the body ceilings (UPLOAD_PATHS, MULTIPART_CEILINGS, OWNER_DOCUMENT_PREFIXES) | body-limit.ts                      | the size a request may send, read by the gate before a row is found and by the loader; they name no caller, open, item or area. Kept a list by the owner's decision of part 0 round 2, and out of the policy count now (arch-counts.mjs ROUTE_LISTS_NOT_POLICY, with why)            |

### 3. Nothing reads a deleted list

- tsc over server/web (the app, the scripts and every test): 0, with the
  files deleted, so no import of a deleted name is left anywhere.
- `git grep -w` of every deleted name over the repo (docs/\_archive out):
  the hits are comments that say "was X" or describe the history, and the
  test-local functions of the same name that read the rows (w6a-route-sweep,
  a4-guard-sweep, member-sweep, create-home-parity: each defined over
  test-support.ts rowAnswers). No code reads a list.
- The sweeps chose their routes from the lists; they choose them off the
  rows now. Before the lists went, each list question (a read, a member
  row, an any-login row, a member's open read and write, the prefix's
  class, the creates, the item a write names) was compared with its
  rows answer over every pattern of the manifest and seven methods (418
  patterns, 2926 cases): 0 differ.

### 4. The rows, byte-equal

- Every row of the manifest and the pages (827: 819 manifest rows, the /s
  page GET and HEAD, the three render pages GET and HEAD), every field,
  dumped as JSON on main d3b6e9281 and on the branch at c7ff2820b: byte for
  byte equal (sha1 773f094d99dd1334b8bd0193342302ee2428a019 both).
- route-policy.rows.json and every file under server/web/server/**snapshots**
  unchanged (git diff against origin/main empty), and the non-DB guard
  sweeps pass on them: a4-guard-sweep (all files), member-sweep,
  auth-sweep, role-sweep, link-render-sweep.

### 5. Pins

- routePolicyLists 14 to 1: the deleted lists (12) and body-limit.ts out
  of the count (1); PUBLIC_PATHS is the one left. ROUTE_LIST_PINS holds
  auth-constants.ts 1 only.
- historyCodeComments 2342 to 2325: seventeen comment lines that named a
  step code went with the lists and the codemod.
- actorsStepRefs 13 to 12: the ADMIN_OPEN_ROWS comment's pointer at the
  spec went with the list.
- itemNonePlaceholders stays 111. (`node scripts/arch-scoreboard.ts --pin`
  was tried and rewrote other pins, some up; it was undone and the three
  pins set by hand.)

### 6. The p2 audits' LOWs

- AREA L1: the changed answer is a class: any area row (an owner or an
  asset caller's) whose area read fails once answers the 500; the cells
  (s9-area-fold.db.test.ts CHANGED) say so. Done.
- AREA L2: httpCaller's JSDoc names ADMIN_STEP_CALLERS (owner, ownerAsset)
  and the asset login. Done.
- AREA L3 (the vitest mock warm-up as a shared helper): not done (left).
- AREA L4: an `?at=` asset token is read on a GET only, in ownerForAsset
  and in the gate's asset view (assetViewLogin). The changed answer: a
  HEAD with `?at=` ignores the token (stricter); through the app the gate
  answered such a HEAD 401 before (the asset cells' HEAD line), so only a
  direct call of the function sees it. Its own cell: not written (left);
  the area cells' HEAD lines cover the app's answer on the workstation.
- FLIP L1, L2 (the lint's callee, top-level spread and `as`/`satisfies`;
  handlerPolicy refusing a missing method): not done (left).
- FLIP L3, for S11b: the creates that name an existing folder in the body
  (POST /api/pages folderId and parentId, POST /api/files/folders parent,
  POST /api/files/files parent) and PUT /api/app-nav/pins (app ids in the
  body). No pin change.
- FLIP L4: kept as named in section 2.
- A8 (the other session's note): the tool-cell time ceiling 210 s to 360 s, with its
  note (a loaded box used about 199 s).

### 7. Changed answers

One, stricter: a HEAD with an `?at=` asset token no longer reads the token
in ownerForAsset and the gate's asset view (L4). Through the app the gate
refused such a HEAD before the view, so no recorded cell moves; the
workstation area cells must confirm it (left). Every row is main's.

### 8. Gates

Mac, DATABASE_URL unset. The full set ran on 351f9f4ef; three failed and
were fixed in 0d76bd528 (two unused imports, a heading quote in a pin
note), and the failed gates were rerun on 0d76bd528:

| gate                                      | 351f9f4ef                                                                                                           | 0d76bd528                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `pnpm -r typecheck`                       | 0                                                                                                                   | tsc over server/web 0                             |
| `pnpm lint`                               | 1 (5 unused imports in two test files)                                                                              | 0                                                 |
| `pnpm format:check`                       | 0                                                                                                                   | 0                                                 |
| `pnpm docs:check`                         | 0                                                                                                                   | 0                                                 |
| `pnpm arch:check`                         | 1 (heading quotes of the history 71 to 72: the pin note quoted this heading)                                        | 0                                                 |
| `pnpm boot:smoke`                         | 0 (14 services link)                                                                                                | not rerun                                         |
| `pnpm -C server/web build`                | 0                                                                                                                   | not rerun                                         |
| `vitest run server packages eslint-rules` | 1 (890 of 891 files; deploy-scripts.test.ts, a spawnSync timeout of its bash harness, load; no code of this branch) | the file alone 0, with the two changed test files |

Workstation: not run this round (handed over at the tool-call budget).

### Left

1. Workstation, on a fresh clone of the pushed head (~/s9p3, copied from
   ~/s9p2): shard 1, shard 2, actor-off, actor-on, edit-on, runtime-role,
   matrix, serial, switch-off full, runtime-role-off full, the area cells
   against the committed records (warn and on). Load-only timeouts rerun
   alone. The DB sweeps that changed (w6a-route-sweep, w6a-fix-sweep,
   precheck-removal-http, a4-head-logins) must pass on their records.
2. AREA L3: the warm-up of a mocked lib/workspaces as a shared test helper
   for every file that mocks it with an async factory.
3. AREA L4's own cell (a direct ownerForAsset call with HEAD and `?at=`).
4. FLIP L1 (route-plumbing.mjs: the callee must be routePolicy, report a
   top-level spread, unwrap `as` and `satisfies`) and FLIP L2
   (route-callers.ts handlerPolicy refuses a policy missing an exported
   method at generate time).
5. S11b: the 111 placeholders, the body-folder creates and the pins list
   (section 6).

## S9 part 3 round 2: the open LOWs, the prefix class off the rows, the gates on one head

Branch feat/s9-p3, on round 1 (1285c8337), not rebased: main moved to
v0.300.146 (0191067ab, the sandbox image) during the round, which touches
no route file, list or sweep. Wave 5 freeze. No migration, no SQL. The
gates ran on 3abdb1cf1; the commit after it is this section.

| commit    | change                                                                                       |
| --------- | -------------------------------------------------------------------------------------------- |
| d073ceeb4 | the mocked area module's warm-up as a shared helper, in every file that mocks it (area L3)   |
| 27a70d4a1 | a direct cell for the asset token on a HEAD (area L4)                                        |
| 8d7914ce3 | the generator refuses a declaration missing an exported method (flip L2)                     |
| dac5e9f86 | the lint reads the declaration as the generator does (flip L1)                               |
| a2a989d73 | a Telegram-only pattern's prefix class read off the rows (item 2)                            |
| c13d9c035 | no audit codes in the new comments of counted files (the history pin holds at 2325)          |
| 3580957cc | the body ceilings' pin note says taking them out of the policy count was accepted            |
| 3abdb1cf1 | the pre-check removal cells read the row's item, not the mocked target (a round 1 test slip) |

### 1. The open LOWs

- AREA L3. server/web/lib/test-support/workspaces-mock.ts
  `warmWorkspacesMock()` imports session.ts, then lib/workspaces, alone.
  Every test file that mocks lib/workspaces with an async factory calls it
  in a beforeAll before any request (16 files: a top-level beforeAll, or
  in s9-area-fold.db.test.ts after its database environment is set;
  gate-caller.test.ts keeps its one area read through the pipeline after
  it, for the cold imports). workspaces-mock.test.ts fails on any such
  file that does not call it (checked by taking the call out of
  role-sweep.test.ts).
  Why session.ts first, found on the way: vitest hands a module's dynamic
  imports the import chain the module was evaluated in, and a chain that
  holds the factory in flight is answered the real module (that is how the
  factory's own importOriginal works). A warm-up that imports the area
  module first runs the factory with nothing loaded, so session.ts is
  evaluated inside it, and every later area read got the real requireArea
  (15 files failed that way: round 2 of part 2 met the same when it tried a
  direct import). Importing session.ts first evaluates it outside the
  factory; then the area module resolves alone and is cached. Proof on the
  Mac: gate-caller.test.ts with no warm-up at `--testTimeout=700` fails 4
  (the 403 on the device token cell); with the helper alone it passes at
  700 and 500.
- AREA L4. gate-caller.test.ts, "an `?at=` asset token is read on a GET
  only": getOwnerForAsset called in a request slot, no gate in front. GET
  with an Admin user's token answers that user; HEAD with the same token
  answers 401. With ownerForAsset's GET check taken out the HEAD line
  fails.
- FLIP L1. route-plumbing.mjs route-policy-declared: the callee must be
  `routePolicy` by its own name (`declare({...})` and `lib.routePolicy({...})`
  are notLiteral); `as`, `satisfies` and `!` are unwrapped around the call
  and its argument (no false report on `routePolicy({...}) as const`, which
  the generator reads); a spread or a computed key at the top of the object
  is reported (`notWrittenOut`) instead of passed over. Cells for each.
  Lint over server/web/app/api: no new report.
- FLIP L2. route-callers.ts handlerPolicy: after the validator, each method
  the route file exports must be named in the declaration, or the generator
  fails at the line ("names no POST, which the file exports"). Two cells.
  The generator over the real tree (vitest's global setup) passes.

### 2. The prefix class of a Telegram-only pattern

test-support.ts rowAnswers `prefixClass` wrote `connectors` in for a
pattern whose rows are all Telegram carve-outs. It reads the class off the
plain rows under the same first two segments now (for /api/telegram: PATCH
/api/telegram/chats/:id, connectors), null where they do not agree on one.
route-policy.test.ts moves that row's area to settings in a copy of the
manifest and sees /api/telegram/pair's class follow. The answers the
sweeps read are unchanged (the same test holds every Telegram row's class
to connectors on the real manifest; w6a-route-sweep and w6a-fix-sweep pass
on their records).

### 3. A round 1 slip, fixed: the pre-check removal cells

precheck-removal-http.db.test.ts failed 304 cells in shard 2 on 3580957cc.
Round 1 replaced main's `itemWriteTarget(method, pattern, path)` (route-scope,
null for every route since the pre-check removal) with
`routeItemTarget(row, path)`, but this file mocks routeItemTarget to feed
the old node targets, so the removed families' check ("the row names no
item") read the mock. It reads the row's `item` now (null for every row,
as main's function answered). A test fix only: no answer moved. The whole
set was rerun on the fixed head.

### 4. The area cells, main against the branch

S9_AREA_RECORD=1 on the workstation, a fresh clone and cluster each: main
d3b6e9281 with the branch's test file, actor-on config and the warm-up
helper laid over, and the branch at 3abdb1cf1, in five lanes.

| lane                                        | main exit | branch exit | lines | branch against main |
| ------------------------------------------- | --------- | ----------- | ----- | ------------------- |
| full run file, warn, switch on              | 0         | 0           | 83    | 83 equal            |
| test:actor-on, on                           | 0         | 0           | 83    | 83 equal            |
| switch off (MANTLE_NARROW_SYSTEM=0), warn   | 0         | 0           | 83    | 83 equal            |
| runtime role off (MANTLE_DB_RUNTIME_ROLE=0) | 0         | 0           | 83    | 83 equal            |
| test:runtime-role, warn                     | 0         | 0           | 83    | 83 equal            |

All ten records are byte for byte one another (md5 494be895...). Against
the committed record each differs by the same 4 lines, main's as well as
the branch's: the `fail:once` lines (part 2's changed answer, 500 where
the committed record has the pre-fold answer); main has part 2, so those
lines are main's now. The HEAD lines with an `?at=` token (`HEAD
attachment at:adm = 401` and its siblings) are equal on main and the
branch: through the app the gate refused such a HEAD before, so L4 moves
no recorded answer. The records hold no machine name (`<env>`, `<email>`).

### 5. Changed answers

None new this round. Round 1's one stands: a HEAD with an `?at=` asset
token no longer reads the token in ownerForAsset and the gate's asset view
(stricter; only a direct call sees it, the cell of section 1). Rows: every
row is main's (round 1's 827 rows, no declaration changed this round;
route-policy.rows.json and the snapshots unchanged against origin/main).

### 6. Gates, on 3abdb1cf1

Mac, DATABASE_URL unset:

| gate                                      | exit                                                                                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -r typecheck`                       | 0                                                                                                                                      |
| `pnpm lint`                               | 0 (the one warning as on main)                                                                                                         |
| `pnpm format:check`                       | 0                                                                                                                                      |
| `pnpm docs:check`                         | 0                                                                                                                                      |
| `pnpm arch:check`                         | 0                                                                                                                                      |
| `pnpm boot:smoke`                         | 0                                                                                                                                      |
| `pnpm -C server/web build`                | 0                                                                                                                                      |
| `vitest run server packages eslint-rules` | 1: 891 of 892 files; deploy-scripts.test.ts, `spawnSync /bin/bash ETIMEDOUT` (its bash harness under load, as round 1); rerun alone: 0 |

Workstation, a fresh clone of the pushed 3abdb1cf1 per suite, own pgvector
pg18 container on a checked free port (removed by exact name), fsync off,
MANTLE_NARROW_SYSTEM=1 unless named, --maxWorkers=3; ~/s9p3 (`TAG=p3
run.sh`, rec-main.sh, rec-branch.sh). Load average up to about 30.

| suite                                     | exit     | files      | what failed                                                                                                           |
| ----------------------------------------- | -------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| vitest shard 1/2                          | 0        | 599        |                                                                                                                       |
| vitest shard 2/2                          | 1        | 598 of 599 | a2a-round-trips.db.test.ts, "page save: off is not stable: expected 17 to be 18" (a round trip count, load); alone: 0 |
| test:actor-off                            | 0        | 169        |                                                                                                                       |
| test:actor-on                             | 0        | 35         |                                                                                                                       |
| test:edit-on                              | 0        | 47         |                                                                                                                       |
| test:runtime-role                         | 0        | 318        |                                                                                                                       |
| test:serial                               | 0        | 1          |                                                                                                                       |
| test:matrix                               | 0        | 4          |                                                                                                                       |
| switch off (MANTLE_NARROW_SYSTEM=0), full | 0        | 1198       |                                                                                                                       |
| runtime role off, full                    | 0        | 1198       |                                                                                                                       |
| the area records, main and branch         | 0 (each) | 1 (each)   | section 4: 83 of 83 equal                                                                                             |

The four DB sweeps round 1 changed passed in every run they are in:
w6a-route-sweep (shard 2, switch off, runtime role off), w6a-fix-sweep
(shard 1, switch off, runtime role off), precheck-removal-http (308 tests:
shard 2, switch off, runtime role off), a4-head-logins (shard 1).

On the superseded head 3580957cc (stopped for the fix of section 3):
test:actor-off met the guard sweep's real-clock window once (a 429
`rate_limited` row in its first pass, the shape part 2 round 2 named); on
3abdb1cf1 test:actor-off passed.

### Left

- CEO audit of part 3 (deletion of a source: nothing reads the deleted
  lists), on this head.
- Rebase onto main v0.300.146 before the merge (no conflict expected: the
  sandbox image touches no file of this branch).
- S11b: the 111 placeholders, the body-folder creates and PUT
  /api/app-nav/pins (part 3, section 6).

## S9 part 3 round 3: the owner opening held to content, the LOWs, onto Present

Branch feat/s9-p3, rebased twice this round: onto main v0.300.147
(3e2720bbc), then, on the owner's word mid-round, onto v0.300.148
(ca6281500, Present merged). The lanes started on the first base were
stopped (their units and containers by exact name) and started again on
the rebased head. Wave 5 freeze. No migration, no SQL. Code and gates on
dab44b685; the commit after it is this section.

| commit    | change                                                                                      |
| --------- | ------------------------------------------------------------------------------------------- |
| f69381061 | the validator refuses `open: 'owner'` off a content row; the owner-open cell (MED-1)        |
| 3adabe4e2 | the handover names no machine (LOW-6)                                                       |
| d7ca50f8a | a member's `?at=` token read on a GET only (LOW-5)                                          |
| 2eabf1498 | the stale pointers at the deleted lists and the codemod (LOW-1)                             |
| 642d735b3 | the body ceilings out of the route list count by their three names (LOW-2)                  |
| 535128f87 | the pin note for it (LOW-2)                                                                 |
| 99a465924 | two test counts after the rebase onto Present (the effect exceptions, the owner-open floor) |
| 355c2b2b0 | the workspaces-mock guard asks for a call (LOW-3)                                           |
| dab44b685 | the lint refuses `export let policy` and a routePolicy not imported (LOW-4)                 |

### 1. The rebase onto Present

Present added its rows to lists this branch deletes: ROUTE_PREFIXES,
READ_POSTS and MEMBER_OPEN_READS (route-scope.ts), FRAME_ROWS
(route-policy.ts) and two ROUTE_GATES rows (route-limits.ts). Each is in
Present's route files' declarations already (class content, `open:
'owner'`, the frame-ticket POST's effect exception, `caller: 'frame'`,
`limits`), so the conflicts took this branch's side, and RATE_LIMITS kept
Present's two limits (memberCanvasFrameTicket, canvasFrame). The kind
registry cell gained /api/presents, the frame cell its two rows, the
effect exceptions count 1 to 2 (the frame ticket). Pins after the rebase:
routePolicyLists 15 (main) to 1 (Present's FRAME_ROWS is a deleted list
now), itemNonePlaceholders 113 as main, historyCodeComments 2325 and
actorsStepRefs 12 as round 1. The codemod's file Present touched stays
deleted.

### 2. The rows, byte-equal to main v0.300.148

Every row of the manifest and the pages, every field, dumped as JSON on
main ca6281500 (a detached copy of main, removed after) and on the branch
after the rebase: 839 rows each (831 manifest rows, 8 page rows), byte for
byte equal (sha1 515f7db7e66ddb5cb5a323978ed5cc520eb0ccf6 both). Before
the second rebase the branch's 827 rows were the 839 less the 12 Present
rows, every other row equal. route-policy.rows.json and every snapshot
under server/web unchanged against origin/main.

### 3. The items

1. Rebase: above (both bases).
2. MED-1. validateMethodPolicy refuses `open: 'owner'` on any class but
   content ("open owner on the class area: only a content row opens to a
   member's item"); the one validator, so the generator (pretypecheck) and
   the boot (declaredFacts) both fail closed. Cells: the two named shapes
   (`{ class: 'area', area: 'settings', open: 'owner' }`,
   `{ class: 'self', open: 'owner' }`, a GET and a write) and a public
   row, refused; with the check taken out the cell fails. A manifest cell:
   every row with `logins === 'owner'` is of the class content and served
   (its method, or a HEAD's GET, in the entry's methods). The proof it
   refuses nothing that exists, on the rebased head: 108 declared methods
   say `open: 'owner'`, all content; they build 185 rows with logins
   owner (35 of them /api/v1 aliases, taking the base's), all content.
   On v0.300.147, before Present: 101 methods, 175 rows, all content.
3. LOW-1. The four pointers: app/api/workspaces/route.ts (the policy's
   `open: 'any'`), server/a8-grants-panel.matrix.test.ts (the same),
   scripts/gen-route-manifest.ts (the generated header: the entry's
   policy), scripts/route-callers.ts (one resolver for the generator and
   its cells). Also route-declaration.ts's placeholder comment (it said
   the codemod writes).
4. LOW-2. arch-counts.mjs ROUTE_LIST_NAMES_NOT_POLICY names body-limit.ts's
   UPLOAD_PATHS, MULTIPART_CEILINGS and OWNER_DOCUMENT_PREFIXES;
   routePolicyLists blanks those lists out and counts the rest of the
   file (body-limit.ts is swept again). A name the file does not declare
   throws. Cells: the file counts 0 with the names and 1 without; a route
   list beside a named one is counted; a stale name throws. Pin note and
   ROUTE_LIST_PINS comment say so. routePolicyLists stays 1.
5. LOW-3. workspaces-mock.test.ts: the guard asks for a call
   (`beforeAll(warmWorkspacesMock)` or `warmWorkspacesMock()` on a line of
   code; an import, a comment or a bare name is not one), and sees
   vi.mock and vi.doMock, by a string or by `import(...)`, in .test.ts and
   .test.tsx. Cells for each shape; with role-sweep.test.ts's call
   commented out the guard fails on it.
6. LOW-4. route-plumbing.mjs route-policy-declared: `export let` or `var
policy` is reported (notConst); a routePolicy call with no import of
   routePolicy by its own name from the declarations module (a local
   function, another module's, a renamed import, a type-only import) is
   reported (notImported). The module name is one constant,
   route-declaration.ts ROUTE_DECLARATION_MODULE, read by the generator and
   the lint. Cells for each; lint over the tree: no new report.
7. LOW-5. memberForAsset reads a member's `?at=` token on a GET only, as
   ownerForAsset does (findMemberAsset takes the URL alone, so the method
   is checked in its one caller, before the lookup). Unreachable on a HEAD
   today: the gate admits an `?at=` token on a GET alone (gate.ts), so a
   HEAD with only a token is answered 401 before any guard. No answer
   moves; no cell (a direct call needs a member login row).
8. LOW-6. The two machine names in the round 1 section are neutral words.

### 4. Changed answers

None new. A HEAD with an `?at=` token was already refused at the gate; the
member path now ignores it too (unreachable). The validator's refusal
refuses no declaration that exists (section 3, item 2). Every row is
main's (section 2).

### 5. Gates

Mac, DATABASE_URL unset, on dab44b685: `pnpm -r typecheck` 0, `pnpm lint`
0 (the one warning as on main), `pnpm format:check` 0, `pnpm docs:check`
0, `pnpm arch:check` 0, `pnpm boot:smoke` 0, `pnpm -C server/web build` 0,
`vitest run server packages eslint-rules` 0 (902 files passed).

Workstation, a fresh clone of the pushed dab44b685 per suite (~/s9p3,
`TAG=p3 run.sh`, rec-main.sh, rec-branch.sh), own pgvector pg18 container
on a checked free port, removed by exact name, fsync off,
MANTLE_NARROW_SYSTEM=1 unless named, --maxWorkers=3. Load average up to
about 31.

| suite                                     | exit    | what failed                                              |
| ----------------------------------------- | ------- | -------------------------------------------------------- |
| vitest shard 1/2                          | 1       | w7b-mcp-surface (2 tests): main's, below                 |
| vitest shard 2/2                          | 1       | a6b-exit-sweep rule-in-query, w7a-tool-sweep (3): main's |
| test:actor-off                            | 1       | a6b-exit-sweep rule-in-query, w7a-tool-sweep (3): main's |
| test:actor-on                             | 1       | a6b-exit-sweep rule-in-query: main's                     |
| test:edit-on                              | 1       | a6b-exit-sweep rule-in-query: main's                     |
| test:runtime-role                         | 1       | a6b, w7a, w7b, presents.db (2): main's                   |
| test:serial                               | 0       |                                                          |
| test:matrix                               | 0       |                                                          |
| switch off (MANTLE_NARROW_SYSTEM=0), full | running | unit s9p3-p3off, exit in ~/s9p3/x-p3off.exit             |
| runtime role off, full                    | running | unit s9p3-p3rroff, exit in ~/s9p3/x-p3rroff.exit         |
| the area records, main and branch         | 0 each  | none; 83 of 83 equal in five lanes                       |

Every failure is main's, from the Present merge, and each was run alone on
main ca6281500 (a fresh clone and cluster, the same config) and failed the
same way:

- a6b-exit-sweep.db.test.ts rule-in-query (test:actor-on on main: 1): the
  committed record's GET /api/shell `treeKinds` has no `present`; the
  shell now lists it (6 changed lines, the same on main).
- w7a-tool-sweep.db.test.ts (test:actor-off on main: 1) and
  w7b-mcp-surface.db.test.ts (vitest on main: 1): the new tools
  present_create, canvas_library and diagram_guide answer the sweep's
  dummy arguments with an error the sweeps do not list as an expected
  refusal.
- packages/content/src/presents.db.test.ts under test:runtime-role (on
  main: 1): `permission denied for function mantle_operator_actor`, the
  runtime role not granted what the Present test calls.

None touches a route row, a list or this branch's code; they are left to
the Present owner (not fixed here: another lane's records and grants).

The area records (S9_AREA_RECORD=1; main ca6281500 with the branch's test
file, actor-on config and warm-up helper laid over, against the branch):
full run file warn, test:actor-on, switch off, runtime role off,
test:runtime-role: each lane's record main against branch 83 of 83 equal,
and every record byte for byte round 2's (md5 494be895...). No machine
name in them.

### Left

- The switch-off and runtime-role-off full runs on dab44b685 (running at
  handover; their exits land in ~/s9p3/x-p3off.exit and x-p3rroff.exit).
- Present's four failing DB tests on main (section 5), for its owner.
- CEO full re-audit (MED) of this head.
- S11b: the 113 placeholders, the body-folder creates and PUT
  /api/app-nav/pins.
