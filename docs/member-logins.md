# Member logins

> Phase 1 of the member logins plan (dev-brain plan v3.1). A member is a user
> of the brain with the member role: users are the team. It is off by
> default: set `MANTLE_MEMBERS=1`.
> What a member may read is decided by Postgres row security at the team level
> ([access-levels.md](./access-levels.md)), never by a check in each route.

## 1. The model

- **Two roles.** `auth.users.role` is `admin` or `member` (migration 0162).
  The anchor (`is_owner`) is always an admin. The role is read from the login
  row on every request, never from a token, so a change takes effect at once.
- **Users are the team** (Jason, 2026-09-26). A login with role member IS
  the team member: it needs no contact, and its display name (else the part
  of its email before the @) is how the agent and the admin see it. Contacts
  are plain contacts; the old team switch and team codes on contacts belong
  to the team portal, which is being retired. `auth.users.contact_id` is an
  optional link, no longer required.
- **Users are contacts in user form.** Every active login's email counts in
  both email gates, inbound (`loadContactGate`) and outbound (the send
  tools), next to the contact list. A disabled login's address does not.
- **Disabled.** `auth.users.disabled_at` set = the login cannot sign in,
  refresh a bearer or use a session it holds. Locking a login out (demote or
  disable) also revokes its mobile bearers and its MCP connector (OAuth)
  grants, and drops its unclaimed pairing codes. Deleting a login deletes all
  of them (FK cascade). Push devices are keyed to the brain, not a login, and
  are not touched.
- **Connector grants belong to a login.** An OAuth grant carries the login
  that consented (`actor_id`, migration 0164). The MCP bearer check, the code
  exchange and every refresh re-read that login: a grant works only while it
  is an admin that is not disabled. Grants made before 0164 are attributed to
  the anchor.
- **Web only.** The mobile companion calls admin routes only, so its login
  (`/api/auth/mobile-login`) refuses a member (403 `member-login`) and mints
  no token. A member signs in from a browser.
- **The flag.** With `MANTLE_MEMBERS` off, a member row resolves to no session
  at all, and no member login can be created.

## 2. Deny by default

- Every admin gate (`getOwnerOr401`, `getOwnerOr401WithSource`,
  `getSessionUser`, `requireOwner`, `getOwnerForAsset`) refuses a member: a
  403 with `reason: 'member-login'`, or no session.
- A member reaches only the routes in `MEMBER_ROUTES`
  (`server/web/lib/auth/member-routes.ts`). Each calls `getMemberOr401` (or
  `getMemberForAsset` for bytes) and reads inside `withViewer('team', …)`.
  `MemberCaller` has no `.id`, so the anchor-scoped call sites cannot take a
  member by mistake.
- `server/web/server/member-sweep.test.ts` drives every manifest route with a
  member session and proves each route not listed refuses it; it also proves
  an admin is refused on every member route.
- A member route is always member-specific. Never put a shared owner route on
  the list.

## 3. What a member can do (Phase 1)

| Route                           | What                                                                   |
| ------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/member/shell`         | Who is signed in, the brain's brand, a member asset token              |
| `GET /api/member/library`       | Team-level pages, notes, drawings, tables, files (see below)           |
| `GET /api/member/library/:id`   | One item with its published body                                       |
| `GET /api/member/files/:id`     | File bytes (`?thumb=1` for a thumbnail); `?at=` works for `<img>` srcs |
| `GET /api/member/draws/:id/svg` | A drawing's committed SVG                                              |
| `GET /api/member/chat`          | The member's own thread with the team-level agent                      |
| `POST /api/member/chat`         | Send a message; the reply lands in the thread                          |

The Library LISTS only items set to exactly Team. Row security lets the team
role read client- and public-level items too, and those stay readable by id
(a link inside a team page opens them) and by the team agent. But an open
link makes an item client or public, often as a side effect (the agent
emailing a page with a link), so listing every such item to every member is
not something an owner chose. To list an item to members, set it to Team.

- **Chat** uses `team-responder`, and only once an admin has set it below
  admin (access-levels.md §5): members chat only with team-level agents, and
  the turn engine refuses an admin agent for a member (`assertMemberAgent`).
  One thread per login (`team_messages.login_id`, migration 0163), never in
  the owner's assistant stream. A member's rows carry the login and no
  contact (migration 0167). Limits per login: 6 messages a minute and the
  team daily cap.
- **Not yet:** accept and return by an admin (Phase 4), running apps (Phase
  4b), attachments in chat. Own items: section 5.

## 4. Turning it on for a brain

1. Set `MANTLE_MEMBERS=1` in the box's `.env` and roll.
2. Set item levels and lower `team-responder` to team (access-levels.md §5).
3. Settings > Users: create a user with role member, and hand the person
   their email and password.

## 5. Personal spaces (Phase 2)

Every login has a personal space: a row in `spaces` (migration 0165), made
with the login by a trigger. `nodes.owner_id` points at a space: the brain
(one row whose id is the anchor login's id, so no brain row changed) or a
personal space. Every brain path filters on the brain id, so a personal item
is invisible to the brain from its first row: never indexed, embedded,
extracted or compiled into Recall. The ingest trigger skips it,
`notifyNodeIngested` and `isBrainOwnerId` refuse inside a space scope, and the
extractor gate checks the owner.

**Three sources** a member reads:

| Source      | What                                                  | Scope                                  |
| ----------- | ----------------------------------------------------- | -------------------------------------- |
| Mine        | the member's own items, drafts included               | `withSpace` (personal-space role)      |
| Team drafts | other members' items shared with the team, saved only | `withTeamDrafts` (team role, human on) |
| Library     | brain items set to team                               | `withViewer('team')`                   |

**The personal-space role.** `mantle_view_space` is a fourth limited LOGIN
role. `withSpace({ spaceId, loginId }, fn)` runs `fn` in one short
transaction on it that sets `mantle.space_id` and `mantle.login_id`; `db`
returns that transaction. Its row rules (0165) show and accept only that
space's rows, workspace kinds only, level always admin (a personal item
carries no level). Drafts are readable there: they are the member's own
working copy. Column grants cannot differ per row, which is why this is its
own role and not the team role: the team role never reads a draft column.

**Team drafts** are visible only to the team role with `mantle.human` on
(`withTeamDrafts`): a member's own request. No agent path sets the flag, so a
team-level agent never reads anyone's drafts. Published columns only.

**Sharing and review** live in `space_items` (one row per personal item):
`sharing` private or team, `review_state` draft, submitted, returned,
accepted. Submit sends the SAVED version (unsaved edits refuse); a submitted
item is FROZEN: the row rules refuse every write until Accept, Return or
Recall. Recall (the author, before Accept) puts it back to draft. The member
can never set accepted.

**Routes** (all in `MEMBER_ROUTES`, all through `inMySpace` or
`withTeamDrafts`):

| Route                                    | What                                          |
| ---------------------------------------- | --------------------------------------------- |
| `GET/POST /api/member/space`             | List Mine; create a page, note or drawing     |
| `GET/PATCH/DELETE /api/member/space/:id` | One item with its body; rename; delete        |
| `PUT /api/member/space/:id/draft`        | Autosave `{ doc \| scene, if_rev }`           |
| `POST /api/member/space/:id/save`        | Save version `{ doc \| scene, if_rev, svg? }` |
| `POST /api/member/space/:id/share`       | `{ sharing: 'private' \| 'team' }`            |
| `POST /api/member/space/:id/submit`      | Submit the saved version for review           |
| `POST /api/member/space/:id/recall`      | Take a submitted item back                    |
| `GET /api/member/team-drafts[/:id]`      | Teammates' shared items, saved version only   |

The draft and save routes keep the owner routes' etag contract (`if_rev` in,
`draft_rev` out, 409 with `current_rev`). State refusals answer 409 with a
`reason` (`frozen`, `not-draft`, `not-submitted`, `unsaved-draft`, `quota`);
another member's item is a plain 404.

**Limits.** 2000 items per space; a page document at most 2 MB; drawings
use the owner's scene and SVG limits.

**Deleting a login** leaves its space and items behind (`login_id` goes
null); deleting a space deletes its items. The 30-day purge of a deactivated
member's private items comes with the deactivation flow (Phase 4).

**Rollback.** 0165 is safe under older code: the brain row keeps every
existing owner id valid. Once personal items exist, never roll back below
v0.232.255 (the extractor's owner check).

**Not yet:** tables and files in a personal space (their bytes live on disk
keyed by owner: the space disk root comes next), the save-time embed rule,
comments on shared items, the `space_item_changed` realtime event, the
my-space agent tools (on behalf of), the admin review screen (Phase 4).
