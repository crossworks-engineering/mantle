# Plan v3.2: the member checks ask Admin membership (handover)

Owner decision 2026-10-26: the five checks that still read the login's
role column after the adapters went move to Admin membership, before the
final audit; `MemberCaller` judged in the same step; the Known limits
bullet of docs/actors.md goes. Branch `feat/s8e` from main v0.400.16
(731e319b6). No migration.

## What changed

A member is a login that is not an Admin user (`adminLogin(row)`:
`mantle_login_is_admin`, read with the row), as the session's
`resolvedFor` has answered since the role followed membership.

| site                                          | before                                                | after                                                                 |
| --------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `session.ts` `findMemberAsset`                | `row.role === 'member'` AND `resolvedFor`'s not Admin | `resolvedFor`'s not Admin (the role read goes)                        |
| `session.ts` `memberLoginActive`              | `row.role === 'member'`, usable                       | `!adminLogin(row)`, usable                                            |
| `mcp-auth.ts` `memberMcpCaller`               | `row.role !== 'member'` refuses                       | `adminLogin(row)` refuses (`loginIsAdmin` in the row's select)        |
| `mcp-auth.ts` `mcpTargetLogin`                | `row.role !== 'member'` refuses                       | `adminLogin(row)` refuses                                             |
| content `login-notices.ts` `toldLoginNotices` | enabled AND `role === 'member'`                       | enabled AND not an Admin user (`mantle_login_is_admin` in the select) |

The answered role of a member caller and a member target is the constant
`'member'` (it was the column's value, which the check had just held to
`'member'`).

## Changed answers

None for a login whose role agrees with membership, which is every login
on every box (role drift 0 and all-logins drift 0, read 2026-10-28). The
role column changes only through the membership definers; drift exists
only where a superuser wrote it by hand. For the two drift logins:

| drift login              | sites                                                                                         | before       | after                    |
| ------------------------ | --------------------------------------------------------------------------------------------- | ------------ | ------------------------ |
| role member inside Admin | memberLoginActive, notices (the other three were already refused by a membership check first) | member       | not a member (narrower)  |
| role admin outside Admin | all five                                                                                      | not a member | a member, as its session |

The second row is not narrower. No role-free check can be: membership
alone cannot tell a role admin outside Admin from a member, and the step
asks for the role column to go. What it gains is no reach beyond its own
session: since the role followed membership its cookie and bearer are a
member session (`resolvedFor`), the member routes serve it, and the OAuth
member grant connects it (`actorMayConnect`). The five checks now answer
it as that session does (its member asset token, the re-check of a stream
or frame it opened, its MCP member caller and consent, its own notices),
where before each refused it. The cells name every changed answer:
`admin-membership.db.test.ts` (asset token, memberLoginActive,
mcpTargetLogin), `admin-facts-handlers.db.test.ts` (an MCP key's caller),
`login-notices-role.test.ts` (who is told).

## MemberCaller

Stays. It is the member routes' record (no `id`, so the brain-handle call
sites cannot take a member by type) and makes no decision: its `role` is
the constant `'member'`, read only by the push routes' audit path.
Replacing it with the Login is a rename (`anchorId` to `brainId`) over
about twenty gates, thirty readers and their test stand-ins, with no
decision in it.

## Pins

| pin                    | before | after |
| ---------------------- | ------ | ----- |
| loginRoleDecisionReads | 16     | 11    |

The 11 left read no caller's role: the requested role of a new or changed
login, a display role, and the peer naming its login
(`peerNamesNoLogin`).

## Gates

Mac, on 87c54a141 (exit codes, DATABASE_URL unset): `pnpm -r typecheck`
0, `pnpm lint` 0, `pnpm format:check` 0, `pnpm docs:check` 0,
`pnpm arch:check` 0, `pnpm boot:smoke` 0, `vitest run` 1 (one load-only
failure: `packages/files/src/pdf-pages.test.ts`, a memory rise of 509 MB
against its 500 MB bound with the whole suite running; 0 alone, 4 passed;
the branch does not touch it), `test:actor-off`, `test:actor-on`,
`test:edit-on`, `test:matrix`, `test:serial` 0 each,
`pnpm -C server/web build` 0.

Workstation, a fresh clone of 87c54a141, each suite on its own pgvector
pg18 container (`s8e-*`, removed), MANTLE_CHECK_FLOOR=keep,
`--maxWorkers=3`, through `~/bin/test-lane`, two at a time:

| suite                    | exit | tests                   |
| ------------------------ | ---- | ----------------------- |
| DB vitest shard 1/2      | 0    | 7155 passed, 19 skipped |
| DB vitest shard 2/2      | 0    | 8711 passed, 12 skipped |
| test:actor-off           | 0    | 1658 passed, 1 skipped  |
| test:actor-on            | 0    | 421 passed, 1 skipped   |
| test:edit-on             | 0    | 596 passed              |
| test:runtime-role (full) | 0    | 3354 passed, 1 skipped  |
| test:matrix              | 0    | 9 passed                |
| test:serial              | 0    | 1 passed                |

This commit adds this file only.

## Open items

- The role admin outside Admin row above: an answer that is not
  narrower, on a state only a superuser's hand write makes. The owner's
  call: keep it (the role column is out of every decision), or put the
  role back at these five as a narrowing only (role member AND not an
  Admin user), which keeps five role reads and the Known limits bullet.
