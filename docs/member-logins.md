# Member logins

> Phase 1 of the member logins plan (dev-brain plan v3.1). A member is a team
> contact with their own login. It is off by default: set `MANTLE_MEMBERS=1`.
> What a member may read is decided by Postgres row security at the team level
> ([access-levels.md](./access-levels.md)), never by a check in each route.

## 1. The model

- **Two roles.** `auth.users.role` is `admin` or `member` (migration 0162).
  The anchor (`is_owner`) is always an admin. The role is read from the login
  row on every request, never from a token, so a change takes effect at once.
- **A member is a team contact with a login.** `auth.users.contact_id` links
  the login to its contact: the contact carries the name, the team limits and
  the provenance of what the member asks for. A member login needs one.
- **Disabled.** `auth.users.disabled_at` set = the login cannot sign in,
  refresh a bearer or use a session it holds. Locking a login out (demote or
  disable) also revokes its bearers.
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
| `GET /api/member/library`       | Team-, client- and public-level pages, notes, drawings, tables, files  |
| `GET /api/member/library/:id`   | One item with its published body                                       |
| `GET /api/member/files/:id`     | File bytes (`?thumb=1` for a thumbnail); `?at=` works for `<img>` srcs |
| `GET /api/member/draws/:id/svg` | A drawing's committed SVG                                              |
| `GET /api/member/chat`          | The member's own thread with the team-level agent                      |
| `POST /api/member/chat`         | Send a message; the reply lands in the thread                          |

- **Chat** uses `team-responder`, and only once an admin has set it below
  admin (access-levels.md §5): members chat only with team-level agents, and
  the turn engine refuses an admin agent for a member (`assertMemberAgent`).
  One thread per login (`team_messages.login_id`, migration 0163), never in
  the owner's assistant stream. The team surface's per-contact rate limit and
  shared daily cap apply.
- **Not yet:** writing their own items (personal spaces, Phase 2), submit and
  accept (Phase 4), running apps (Phase 4b), attachments in chat.

## 4. Turning it on for a brain

1. Set `MANTLE_MEMBERS=1` in the box's `.env` and roll.
2. Set item levels and lower `team-responder` to team (access-levels.md §5).
3. Settings > Logins: create a login with role member, linked to the
   person's team contact.
