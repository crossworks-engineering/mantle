# Plan v3 S6 part c1 handover

Branch `feat/s6-c1`, on main 464c748df (v0.300.98; built on 405f351da). Not merged, not tagged,
not rolled. Plan v3.2 section "S6. Admin acts become definers", part c1 only.

## Done

Four Admin acts get one narrow SECURITY DEFINER function each, in one
migration, `packages/db/migrations/0308_admin_act_definers.sql`:

| Act                 | Route                           | Definer                                                               | Body (system door)                                  |
| ------------------- | ------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| a contact's sharing | POST /api/contacts/:id/sharing  | `mantle_contact_sharing_set(contact, action, code_hash)`              | `mantle_contact_sharing_rows(owner, …)`             |
| Revoke all          | DELETE /api/contacts/:id/shares | `mantle_contact_shares_revoke_all(contact)`                           | `mantle_contact_shares_revoke_rows(owner, contact)` |
| share with contacts | POST /api/shares/contacts       | `mantle_share_with_contacts(node, contacts, tokens, write_on, kinds)` | `mantle_share_with_contacts_rows(owner, …)`         |
| entity merge        | POST /api/entities/merge        | `mantle_entity_merge(canonical, dup)`                                 | `mantle_entity_merge_rows(owner, canonical, dup)`   |

- The check, inside each definer: `mantle_admin_act_brain(act)`. The
  scope's own login (`mantle_scope_login_id`) is an Admin user
  (`mantle_login_is_admin`, 0304) and the brain's live Admin workspace is in
  the scope (`mantle_scope_ws`). Else 42501 (detail `admin_act_unscoped` or
  `admin_act_admin_only`), which the route callers answer as the guard's
  own 403 (`AdminActRefusedError`, the body of `loginRefused('member')`).
  This is the shape of `mantle_scope_has_area` with
  "an Admin user" for "holds the area". No area names these acts, and
  today's rule is "an Admin user" (the guard sends only `res.kind === 'admin'`
  to them). An area would refuse an Admin user with that area off: a
  narrower answer nobody asked for. So the brief's "Admin by
  mantle_scope_has_area" is read as its shape, not one area. Say if an area
  is wanted.
- No system work branch: nothing runs these acts without an Admin user.
  Unscoped is refused.
- One SQL body per act. The definer calls it for `mantle_brain_id()`. The
  content functions with an owner (`enableContactSharing`,
  `regenerateContactCode`, `disableContactSharing`, `createContactShares`,
  `revokeAllContactShares`, `mergeEntities`) call the same body with no
  check, in a transaction (the system actor bound): the nightly
  entities-dedupe sweep, its CLI, and the test fixtures. So the TypeScript
  copies of these writes are gone. The bodies add no right: the runtime
  role writes these tables directly.
- What only TypeScript knows comes in as an argument: the code hash (HMAC
  keyed by `MANTLE_MASTER_KEY`), the new links' tokens, and the kinds a
  contact share may name (`CONTACT_SHAREABLE_TYPES`, the kind registry).
- The scope for the definer: `adminActTx(loginId, fn)` (new,
  `packages/db/src/admin-act.ts`). One transaction on the system pool with
  `mantle.ws` and `mantle.mod_ws` from `loginScopeFor` and the login in
  `mantle.scope_login`. `mantle.login_id` stays unset, as `systemPoolTx`
  does. Not in `client.ts` (no `dbClientLines` move).
- Route callers: `adminContactSharing`, `adminRevokeAllContactShares`,
  `adminCreateContactShares`, `adminMergeEntities`
  (`packages/content/src/admin-acts.ts`). The handlers call them with
  `user.actor.id`. The handlers' `getContact` pre-checks went (POST sharing,
  DELETE shares): the definer answers "not a contact" (the same 404).
  `GET /api/contacts/:id/shares` keeps its `getContact` (a read, not c1).
- Grants: PUBLIC loses EXECUTE on all nine. The runtime role runs the four
  definers and the four bodies from `RUNTIME_SYSTEM_FUNCTIONS`
  (`packages/db/src/runtime-role.ts`, each with why). No viewer role, the
  write role or the gap writer gets one. `mantle_admin_act_brain` is the
  definers' own.
- Not touched: `session.ts` (`anyLoginScope`, `ADMIN_ACT`), `route-scope.ts`
  (`ADMIN_ACT_WRITES`), `packages/db/src/access-matrix.ts`. The four
  requests keep their route class and stay on the system pool
  (`noteRequestSystem('admin-write')`). No matrix row was needed.
- Tests moved: `server/web/app/api/contacts/contact-sharing-routes.db.test.ts`
  now runs on its own scratch brain with its owner an Admin user (it ran on
  the shared test database, where no Admin workspace holds its owner).

## Answers

Recorded against main by the existing cells of
`server/web/server/f4-owner-flows.db.test.ts` (H1, M2, H2, the member cell;
they run unchanged on this branch), `contact-sharing-routes.db.test.ts`
(its cells unchanged), the body sweep, and the new
`server/web/server/s6-c1-admin-acts.db.test.ts`.

HTTP answers: byte-equal for an Admin user and for a member (403, the
guard's). Changed, all narrower or internal:

1. One transaction instead of two: the "not a contact" read and the write
   are now one definer call (before: `getContact`, then the act).
2. Times come from the database (`now()`, the transaction's start), not the
   app's clock: `revoked_at`, `rotated_at`, `disabled_at`, `created_at`,
   `updated_at`, and the "expired" test of Revoke all and of the share
   create.
3. An Admin user who stops being one between the guard and the definer
   (disabled, removed from Admin, Admin archived) is now refused inside
   with the guard's own 403 (`{ error: 'forbidden', reason:
'member-login', message: 'Not available to member logins.' }`).
   Before, the act ran. Narrower.
4. A login with role `admin` and no seat in the Admin workspace (role
   drift), or any login while the Admin workspace is archived, got 200 on
   main (the guard let it through as an Admin user). It now gets that 403
   from inside the definer, on all four routes. Narrower. Role drift is 0
   on all 8 boxes (the CEO session's count). Cell: "a member, and a login
   with role admin outside Admin, reach none of the four acts".
5. Entity merge, the alias fold: JavaScript `trim()` and `toLowerCase()`
   become a regex trim (`[[:space:]]`, U+00A0, U+FEFF) and `lower()`. Equal
   for every alias seen; an alias with another Unicode space at an end, or
   a letter whose case rules differ, may fold differently. Not an answer
   (the route answers `{ ok: true }`).
6. `createContactShares` called directly (no route) with a contact id that
   is no uuid: a `not-a-contact` refusal instead of a 22P02 error. The
   route validates uuids first (zod), so its answer is unchanged.
7. POST /api/contacts/:id/sharing in a process with no `MANTLE_MASTER_KEY`:
   the new code is made (keyed by the master key) before the definer
   answers "not a contact", so it answers 500 where main answered 404.
   Every box has the key. Named in the body sweep
   (`server/web/server/a10-body-sweep.test.ts`, kind `code-first`, 1 cell,
   its change snapshot).

## Pins

- `historyCodeComments` 2335 to 2351: `S6` joins `HISTORY_HEADING_CODES`
  with this heading, so the 16 comment lines that already named S6 count.
  c1 adds no counted comment line. Reason in the pins' notes.
- `adminActRoutes` stays 7 (no route left its class in c1).
  `inHandlerAreaChecks` unchanged (the removed `getContact` checks are no
  area checks).

## Tests

`server/web/server/s6-c1-admin-acts.db.test.ts`, warn and on (actor and
edit check together):

- each definer: an Admin user's scope yes; a member's scope, no scope, an
  Admin user over a scope without the Admin workspace, a scope with no
  login, and a disabled Admin user: 42501, nothing written;
- each route by runRoute as an Admin user who is not the owner, and as one
  without the users area: every answer (200, 409 already-on, 409
  sharing-off, 400 refusals, 404 not a contact, 404 entity not found);
- member-negative per route: 403, nothing written; the same for a role
  drift login, with the guard's 403 body;
- the merge moves a fact and an edge of the duplicate from a note homed
  in another workspace, with both checks on;
- the system door and the definer write the same rows (aliases
  byte-equal).

## Gates (exit codes)

Audit round 1 (8/10, fix first) folded in, rebased on 464c748df. The
head SHA, the gates with exit codes and the CI run are in the report to the
CEO session and listed here:

All on code head a96562494 (rebased on 464c748df); the commit after it
changes this file only.

Mac (DATABASE_URL unset):

| Gate                                                | Exit |
| --------------------------------------------------- | ---- |
| `pnpm -r typecheck`                                 | 0    |
| `pnpm lint`                                         | 0    |
| `pnpm format:check`                                 | 0    |
| `pnpm docs:check`                                   | 0    |
| `pnpm arch:check`                                   | 0    |
| `pnpm -C server/web build`                          | 0    |
| `pnpm exec vitest run server packages eslint-rules` | 0    |

Workstation (own pgvector pg18 container on 56095, its own worktree, both
removed after; migrate with `MANTLE_CHECK_FLOOR=keep`, exit 0):

| Run                           | Exit | Files                  | Tests                    |
| ----------------------------- | ---- | ---------------------- | ------------------------ |
| full vitest with the database | 0    | 1118 passed, 1 skipped | 13744 passed, 39 skipped |
| `test:actor-off` config       | 0    | 126 passed             | 1145 passed, 1 skipped   |
| `test:runtime-role` config    | 0    | 271 passed             | 2709 passed, 1 skipped   |

Under the runtime role `contact-sharing-routes.db.test.ts` runs its 5
tests (audit MED-1: before, all 5 skipped) and `s6-c1-admin-acts.db.test.ts`
its 10.

Found and fixed in this round, beyond the audit's list: the route callers'
refusal mapping called itself (a slip in the LOW-2 change, caught by the
body sweep before any commit was pushed); `adminActTx` now sets the scope
through `systemPoolTxInScope`, the one hand-set scope on main since S2a
a1+a2, its call site pinned in `eslint-rules/scope-settings.mjs`; the A10
error sweep stands in `adminActTx` (a forced failure at the database, as
its transaction met it before).

## Rollback

N-1 works on this schema: 0308 adds functions only (no table, row,
trigger or grant change on anything N-1 uses), and N-1 calls none of them.
Nothing to revert: roll the N-1 image back and leave 0308 in place.

## Renumber proof

Built as 0306 (the next free number on main then: the journal test "no
slot is skipped" refuses a gap). At the merge S8a took 0306
(0306_admin_membership) and S2a a1+a2 0307 (0307_ws_user_definers), so the
rebase onto 464c748df renamed it 0308_admin_act_definers, journal idx 308,
`when` 1790197800000 unchanged (above 0307's 1790197740000), and every
"migration 0306" comment of this branch to 0308. The proof cell:
`packages/db/src/migrations-journal.test.ts`, "0308 is the Admin act
definers, renumbered from 0306 with the same `when`".

## Left

- c2: the share close by an Admin user (users area), the contact share
  "Can write" PATCH, the deleted-app trash rows.
- c3: the rest of `anyLoginScope`'s admin-write; then the four c1 requests
  can run in the login's scope (the definer is ready for it: give the write
  role and the workspace role EXECUTE then).
- The kinds come from the caller (`kinds`): the rule of what a contact
  share may name stays in TypeScript, as the kind registry is. Fine while
  only the runtime role runs the function.
- Open for c3 (audit LOW-6): `@mantle/content` (index-team.ts) still
  exports the owner functions that skip the Admin check
  (`enableContactSharing`, `regenerateContactCode`, `disableContactSharing`,
  `createContactShares`, `revokeAllContactShares`); only tests call them.
  Moving them to a test-support entry needs a new package export and four
  test files rewired (a8-surfaces, f9-contact-export, w6b-fix2,
  contact-share-gate), so it waits. `mergeEntities` stays: the sweep uses
  it.
- For S7 (audit LOW-4, the CEO logs it): the system door to the `*_rows`
  bodies is not limited by actor.
