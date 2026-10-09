# Workspace review pattern

Status: decided 2026-10-09. Apps are built. Pages, notes, tables, draws and
files follow, one workspace at a time, in the order below.

## The rule

What members submit or share is reviewed **in the workspace it belongs to**,
with the **normal item screen**, never on a separate Team admin review screen.

- Each workspace screen (Apps, Pages, Notes, Tables, Draws, Files) shows two
  sections above its normal tree, each hidden while empty:
  - **Waiting for approval**: what members submitted. Title, author, sent
    when, version.
  - **Shared by members**: what members shared with the team. Title, author,
    whether the author is still an active member, last activity.
- Opening one shows the item in the **normal item screen** for that kind,
  read only where the admin must not edit a member's work, with a banner:
  - "Submitted by NAME. Waiting for your approval." Actions: **Approve**
    (asks the level and anything kind-specific, shows the version, confirm
    dialog, sends the pinned version) and **Reject** (no note; the item
    returns to the member as `returned`, editable, and they can submit
    again). The member reads "Rejected by the reviewer. Change it and
    submit it again." The route keeps its name, `send-back`.
  - "Shared with the team by NAME." Actions: **Unshare** (back to private,
    nothing deleted), **Delete** (to the brain trash, restorable for 30
    days), **Activity** (where the kind has an activity log).
- Team admin keeps only a small "N waiting in WORKSPACE" link per workspace
  that has something waiting. The Team admin review tabs go away.

**No comments in review flows.** No thread, no note, no message, on any
kind, now or later. People talk through their own channels; the brain does
not grow a messaging system for reviews. Reject carries no text. The old
`space_items.returned_note` column stays in place (no destructive
migration) but nothing writes or shows it once a workspace moves to this
pattern. Since 2026-10-09 the brain has no comments at all (task comments
included); user-to-user talk moves to the forum.

## Security lines every workspace keeps

1. **Admin only.** Every review route runs `getOwnerOr401()`. The role,
   member and client sweeps cover new routes automatically.
2. **No private draft ever shows.** What an admin may reach is one rule in
   one query per kind: submitted, or shared with the team. A private item
   answers exactly like an id that does not exist. The admin reads the
   PUBLISHED or committed body, never the author's working draft.
3. **Approve is pinned.** The detail carries the version (and, where the body
   can change under the admin, a hash of what was shown). Approve sends it
   back and the locked accept refuses when either moved.
4. **Lock order.** The state row (`space_items`, FOR UPDATE), then any kind
   lock (the app history lock), the same order a member's change takes.
5. **Author active.** A shared item of a disabled, demoted or deleted author
   reaches nobody; the list says so.
6. **Testing never writes the real thing.** Where an item runs (apps today),
   the admin's test runs at team rules on a throwaway copy that goes when the
   admin leaves or after an idle timeout, with no MCP, no exports and no
   outside tools.

## Apps (built 2026-10-09)

Brain (mantle):

- `listMemberAppsForReview()` and `getMemberAppForReview(id)` in
  `packages/content/src/member-space-apps.ts`: the two lists and the detail,
  on the `adminVisible` rule. `sendBackSpaceApp(id, reviewer)` replaces the
  old return with a note.
- `packages/content/src/app-review-test.ts`: the throwaway test copy under
  `APP_DB_DIR/_tmp/review/<admin login>/<app>.sqlite`. Rows only, informational
  apps read only, host.me() without touching the real registry, 30 minute
  idle sweep, at most 3 copies per admin, and the nightly `_tmp` sweep as the
  last backstop.
- Routes under `/api/apps/members`: the lists, `:id`, `history`, `activity`,
  `accept`, `send-back`, `unshare`, `delete`, and the test run (`test`,
  `test/frame-ticket`, `test/frame`, `test/db-broker`, `test/tool-broker`).
  The test frame takes only a review test ticket (`rv` claim); every other
  frame route refuses it. `/api/team-admin/app-submissions/*` and
  `/api/team-admin/member-apps/*` are removed.

UI (jackdaw):

- The two sections above the Apps tree, the review screen at
  `/apps/review/<id>` (the app screen's Builder, Code, History and Activity
  views, read only, with the banner), Recently deleted apps at the foot of
  the list, and the "N waiting in Apps" link on Team admin.
- The member's Apps page shows each app's state (private, shared, waiting,
  rejected) and no note.

## What is reusable

Brain:

- The two-list shape (`waiting`, `shared`) and the review author shape
  (`ReviewAppAuthor`: login, name, active) are generic. Each kind adds one
  `list<Kind>ForReview()` and one `get<Kind>ForReview(id)` on its own
  visibility rule.
- Reject (no note) is one guarded update of the state row; the same
  shape for every kind (`member-review.ts` `returnReviewItem` becomes a
  no-note reject for the kinds that move). The UI says Reject; routes and
  the `returned` state keep their names.
- Unshare and Delete to trash exist for apps; pages, notes, tables, draws and
  files need the same two admin acts (Delete moves the item into the brain
  first, then the normal delete keeps it restorable, as
  `adminDeleteSpaceApp` does).

UI:

- `WorkspaceReviewSections` (the two lists) and `ReviewBanner` (the banner
  with its actions) take the kind's rows and actions as props; the per-kind
  screen supplies the normal item view in read-only mode.
- The Approve dialog (level, version, confirm) is shared; kinds add their own
  extra choice the way apps add "trust its tools".
- The "N waiting in WORKSPACE" link on Team admin takes a count per kind.

## Order for the other workspaces

1. **Pages.** The most submitted kind, and the read-only page view exists
   (the share presenter). Move Accept, Reject, Take over and the
   left-behind Discard from Team admin > Review into /pages. Bundles (a page
   and what renders inside it) keep their current accept move.
2. **Notes.** Same flow as pages, smaller body; the note presenter is the
   read-only view.
3. **Tables.** Read-only grid view exists; Approve keeps the table's schema
   and rows as submitted (pin by version).
4. **Draws.** Read-only canvas view (the SVG render); pin by version.
5. **Files.** No body to edit; the review is the file viewer plus Approve
   (which folder, which level) and Reject.

Each step: brain functions and routes first, then the UI section and banner,
then remove that kind from Team admin > Review. Team admin > Review goes
when the last kind has moved. Each step gets its own independent audit.

## Decisions still open

- **Shared by members for items.** Apps already show team-shared apps of
  active members to admins (access matrix N2). For pages and the other
  kinds, `member-review.ts` today lets an admin read a team-shared item only
  when its author is deactivated. Showing every team-shared item to admins
  widens that rule; it needs the owner's decision before the Pages step.
- **The item review comments**: removed on 2026-10-09 with every other
  comment surface (not per workspace); the stored rows stay.
