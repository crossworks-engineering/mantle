# Plan v3 S6 part c3 handover

Branch `feat/s6-c3`. Built on `origin/feat/s6-c2` (e50fd5f51, c2 not merged
yet, by the CEO's word); rebase onto main once c2 is merged. Not merged,
not tagged, not rolled. Plan v3.2 section "S6. Admin acts become
definers", part c3. No migration: no new definer was needed (below).

## Measured first

The `admin-write` request exit had two sites on main (requestSystemExits 5,
admin-write 2). Per route, from the route policy rows (`anyLoginRow`, write
effect) and `enterLoginWrite`:

| Site                           | Routes (an Admin user's write)                                                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anyLoginScope` (12 rows)      | POST /api/access-keys, DELETE /api/access-keys/:id; POST /api/assistant/turn, read, threads, threads/:id/continue, threads/:id/summarize, transcribe; POST /api/telegram/pair, chats/:id/block, chats/:id/unpair, DELETE /api/telegram/my-chats/:id |
| `enterLoginWrite` (4 rows, c1) | POST /api/contacts/:id/sharing, DELETE /api/contacts/:id/shares, POST /api/shares/contacts, POST /api/entities/merge                                                                                                                                |

The grants and workspaces writes were in the scope already (F4, S2a a2).

## Done

- `anyLoginScope` (session.ts): every login enters its scope on an
  any-login row, reads and writes alike. `inLoginScopeForWrites` and
  `noteSystem` are gone.
- `enterLoginWrite` (session.ts): no Admin act branch. `ADMIN_ACT_WRITES`
  and `adminActWrite` (route-scope.ts) are gone. The four c1 acts run in
  the login's scope; their handlers already called the definers through
  `adminActTx` (a system-pool transaction with the scope set: the write
  role holds no EXECUTE on the definers, and access-matrix.ts is S2c's).
  Their other reads (`contactSharingFor`, `listContactSharesForAdmin`) are
  definers granted to the workspace role.
- The Admin-only branches, each already a definer or a named exit, so no
  new definer and no migration:
  - another login's key: `mantle_access_key_revoke` (0293, 0306) checks
    the scope's own login and "an Admin user" inside; it now runs on the
    write role in the Admin user's scope.
  - a moderated bot's chat: `setChatPairing` and `loginModeratesBot`
    (`@mantle/telegram`) run by the named exit `'login-telegram'`, the
    users area asked by `loginHasArea` (mantle_area_rule). Unchanged.
  - a key make: its body leaves the scope by `'rule-in-query'`, as for a
    member (the password check reads the login's hash). Unchanged.
- `resolveChatAgentToWrite` (lib/assistant-chat.ts), used by the chat
  writes (read, threads POST, turn): in the scope an Admin user does not
  read another workspace's assistant row, so an explicit slug of it fell
  through to the default agent (found by the first DB run: the A6b exit
  sweep, `POST /api/assistant/read` agent=P/Q, 404 on main, 200 for the
  default agent on the branch). Now an explicit slug that does not resolve
  to itself is null, for every login (a member's rule already).
- c1 audit LOW-6: the owner functions that skip the Admin check
  (`enableContactSharing`, `regenerateContactCode`,
  `disableContactSharing`, `createContactShares`,
  `revokeAllContactShares`) left `@mantle/content`'s main entry for a
  `@mantle/content/test-support` entry. `eslint.config.mjs` refuses a
  static import of it in `server/**` outside test files. Four tests
  rewired (contact-share-gate, a8-surfaces, f9-contact-export, w6b-fix2).
  `mergeEntities` stays (the sweep uses it).

## Answers

Byte-equal for every HTTP answer recorded on main (the A4 guard sweep,
the A10 body sweep, the A6b exit sweep, w7c, w7d, the access keys suites,
f4-owner-flows, s6-c1, s6-c2), with these changes:

1. Where the 12 any-login rows and the 4 c1 acts run: the A4 guard sweep
   re-recorded for those rows only (`out=system:admin-write` to
   `out=user:true`, 4 Admin credentials each; every status and body
   equal). `a4-guard-sweep-moved-writes.txt` unchanged.
2. Narrower: an Admin user's chat write with an unknown or disabled
   explicit slug answered as the default agent (200, or a turn with the
   default assistant); now the route's "no agent" 404. A member's did
   already. Cell: `s6-c3-any-login-writes.db.test.ts`.
3. Narrower in theory: a chattable agent with no workspace that an Admin
   user's scope does not read would now answer "no agent" on a write. None
   seen (no fixture holds one).
4. A key revoke of another login's key keeps today's rule, "an Admin user"
   (with or without the keys area). The plan's "with the keys area" is not
   today's rule (the list shows every key to every Admin user too); left
   for the owner (Open).

## Pins (each with its reason in the pins' notes)

- `requestSystemExits` 5 to 3, `requestSystemExits_adminWrite` 2 to 0.
- `adminActRoutes` 4 (after c2) to 0.
- `routePolicyLists` 16 to 15 (ADMIN_ACT_WRITES); `no-policy-name-lists`
  route-scope.ts 5 to 4.
- `loginKindBranches` 51 to 50, `historyCodeComments` 2345 to 2343,
  `actorsMdLines` 350 to 348.
- `inHandlerAreaChecks` unchanged: the keys area ask of the key make
  (`holdsKeysArea`) decides its 400s before the password; moving it into a
  definer reorders the answers (Open).

## Tests

- New `server/web/server/s6-c3-any-login-writes.db.test.ts` (warn and on,
  runRoute): an Admin user (with and without the keys and users areas)
  revokes a member's key; role drift and a member do not (404, key live);
  every login revokes its own; the key make's order (risky tools 400 before
  the password 403); chat writes naming another workspace's assistant or
  an unknown slug answer 404 and write no cursor; member-negative.
- Re-recorded: `__snapshots__/a4-guard-sweep.txt`, `-moved.txt`,
  `-rule-in-query.txt` (the moved rows only, code-first).
- `route-scope.test.ts`: the four acts are content writes no member
  reaches (the list is the test's own now).

## Gates

See the report to the CEO session for the head SHA, the exit codes and the
CI run. Workstation container `s6c3_verify_pg` on 56313 and worktree
`s6c3-verify`: removed by exact name after the full runs.

## Open

- The c2 round-2 builder re-records the A4 guard sweep and the A10 body
  sweep for c2's four rows; this branch re-recorded only its own rows, so
  the rebase onto main after c2 merges may need the sweeps re-run (`-u`)
  and the diff checked again with the per-route compare.
- Keys area for another login's key (owner): today "an Admin user".
- The Telegram moderated-chat branch as a definer (`mantle_area_rule` thin
  call, or a definer with `mantle_scope_has_area('users')`) and the key
  make's area ask in SQL: both need EXECUTE for the write role
  (access-matrix.ts, S2c's) and a migration; S7 or a c4.
