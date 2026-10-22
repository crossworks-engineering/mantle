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
