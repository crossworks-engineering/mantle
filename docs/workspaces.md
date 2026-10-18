# Workspaces: who reads and changes what

This is the one guide to access in a brain. Workspaces replace the old
tiers (admin, team, client and public levels on items, agents and tool
groups). The switch came in phases W1 to W8 (workspaces plan, dev brain
page `4887b8e7`). The older pages that describe levels, member logins,
client logins and the team chat are history; each one now points here.

The rules live in the database (row security and the write checks in each
statement), not in each screen. So a user gets the same answer in Jackdaw,
the phone app, MCP and the HTTP API.

## The model

- A user is a login. Users are flat. A login carries no permission of its
  own: everything a user may read or do comes from the workspaces they are
  in.
- A workspace has a name, a description, an optional contact (information
  only), users, at most one assistant, and connectors.
- Each user of a workspace has a **Moderator** tick.
- A user can be in many workspaces. They keep one login, and a switcher
  changes the current workspace. You pick only a workspace you are in,
  Admin users too: an Admin user joins a workspace first (it is logged),
  then picks it.
- An item is shared by a **grant** to a workspace. Each grant has its own
  **Write** switch.
- Every item has exactly one **home** workspace.
- Users of a workspace read every item granted to it. They change an item
  when its grant has Write on, or when they are a Moderator of its home.
- A workspace has no read or write switch of its own, and no private flag.
  A workspace with one user is private.
- Permissions are set in two places only: the workspace screen
  (**Settings > Workspaces**) and each item's **Grant Access** panel.
- Nothing grants by itself ("no magic"). The one exception: an item placed
  in a folder takes the folder's grants, and the dialog says so first.

## Workspaces and users

Open **Settings > Workspaces**. One screen per workspace holds its name,
description, look and contact, its users with their Moderator ticks, its
assistant, its connectors and its landing page.

Each workspace has a **look**: a colour and an icon, picked the way a
folder's are (the same palette and the same icons). The workspace switcher
shows it, and so do the share marks on the item tree. With no colour or icon
picked, the workspace shows a neutral colour and the default icon of its
kind: Admin, a private workspace, or any other. (Team, a normal workspace
since migration 0286, kept the icon its old kind drew.)

The workspaces a brain has:

- **Admin**: exactly one, and the only workspace with rules of its own.
  Its users manage the brain (see "Admin areas"). It keeps its name,
  cannot be archived, and keeps at least one Moderator. An admin login is
  its user and a Moderator there, always (owner decision, F4 fix round 1):
  the tick of an Admin user on Admin is never cleared (409
  `admin_workspace`), an add to Admin is one with the tick, and removing
  the user from Admin (the role change to member) is the only way to take
  it away. Migration 0298 ticked every Admin user who was not.
- **Team**: on a brain switched to workspaces before migration 0286, the
  shared workspace the switch made. Since 0286 (owner decision 2026-10-13)
  it is a normal workspace: renamed, archived and moderated like any
  other, with the same name, items, grants and users. Its Moderators kept
  their ticks; an Admin user reviews them on the workspace screen. A new
  brain has no Team workspace.
- **A private workspace per user**, named after the user with "(only
  you)". The brain makes it the first time the user needs it. Nobody else
  is in it, and it is not granted to Admin.
- **A "Former user" workspace** for the items of a login that was removed.
  It has no users. An Admin user may join it.
- Any other workspace a user makes. Any user may make one. They become its
  only user and its Moderator: the one way to become a Moderator without
  an Admin user.

Who may change a workspace:

- **A Moderator** adds users (by a search on name or email), removes
  users who are not Moderators, edits the name, description and look, and
  sets the landing page.
  The look follows the name's rule: whoever may rename a workspace sets its
  colour and icon, on every workspace. Admin keeps its name, but its look
  can change (its Moderators are Admin users). A Moderator outside Admin
  types at least 3 letters and sees at most 10 matches.
- **Only an Admin user** (with the users area) sets or clears the
  Moderator tick, on any workspace, adds a user with the tick, and removes
  a Moderator (owner decision 2026-10-13, migration 0286; removing is the
  same check, so a Moderator cannot remove another and add them back
  without the tick). A Moderator who is not an Admin user adds users
  without it; the screen shows the tick switched off, with "Only an Admin
  user can change the Moderator tick.", and another Moderator's Remove
  dimmed, with "Only an Admin user can remove a Moderator." The brain
  answers 403 `admin_only` to anyone else.
- **An Admin user** (with the users area) sees every workspace and may add
  anyone to any workspace, themselves included. The add is logged and the
  screen shows "Added by NAME on DATE".
- **A new login** (an invite, or **Add login**) gets its private workspace
  the first time it needs one, and an admin login joins Admin as a
  Moderator. That is the only membership the brain gives by itself (until
  0286 every new login also joined Team as a Moderator, plan Q1). Any
  other workspace needs a Moderator or an Admin user to add the user.
- **Any user** may leave a workspace, a Moderator too. Nobody removes or
  demotes the last Moderator: "An Admin user must make another user a
  Moderator first."
- **Archiving** a workspace (a Moderator of it, or an Admin user) removes
  its grants from the items granted to it. The confirm lists the counts
  first. It is refused while any item still has its home there: move those
  items first. The Admin workspace cannot be archived; Team can, like any
  other, since 0286.

Every change of users, Moderator ticks, grants and resources writes a
`workspace_events` row. A workspace or a login the caller may not see
answers 404, never 403.

## The landing page

Every workspace has a landing page. It is what a user sees at the root of
the app (**Home**) while that workspace is their current workspace. When
they switch, the landing page changes with it.

- **The Built-in home** is the default, for every workspace, Admin
  included. It shows that workspace's data: its newest pages, how many
  items of each kind it reads, and the apps it holds that the user may run.
- **A home app** replaces the Built-in home. A Moderator of the workspace
  sets it on the workspace screen, under **Landing page**. Only an app the
  workspace holds (share it with the workspace in Grant Access first) with
  a working published build can be picked. Picking makes no grant.
- If the workspace stops holding the app (its grant is removed, by any
  path), the brain forgets the pick: the landing page is the Built-in home
  again, and sharing the app again does not bring it back. Only a Moderator
  picks it again. If the app's build breaks, the pick stays and the landing
  page shows the Built-in home until the build is green.
- The screen names the home app only to the users of the workspace. An
  Admin user outside it sees that one is set, not which.
- **All my workspaces** in the switcher shows the Built-in home over every
  workspace of the user. It never shows a home app. A user who never picked
  a workspace lands here; the browser remembers each pick after that.
- **Who sets it.** Every Moderator of the workspace. A pick opens for every
  user of the workspace, Admin users included. The app still reads only what its holder workspaces read (see
  "Apps"): a landing page gives it no more. Each change is logged as a
  `workspace_events` row, `workspace.landing`.
- An Admin area does not set another workspace's landing page: only its
  Moderators do. An Admin user who should set one is made a Moderator of
  it (by an Admin user).
- The brain health **Dashboard** is no landing page. Admin users with the
  settings area open it from the menu.
- The landing page always reads in the user's own workspaces: an Admin
  user's Home never shows the whole brain.

A home app reads the same data through `host.hub.get()`, kept to the
workspace: [Workspace home apps](./guide/07-api/07-member-home-apps.md).
On the wire: `GET /api/home?ws=<id>` answers the landing page (no `ws`:
all my workspaces), and `PATCH /api/workspaces/:id` with `landingAppId`
sets it (`null`: the Built-in home).

## Search and the switcher

The switcher narrows the lists, not search (task f26a516e).

- **Search** (the search palette, and a search in the Pages, Files and
  other item lists) looks in every workspace the user reads. Hits from the
  current workspace come first. A hit from another workspace carries a
  small tag with that workspace's name; opening it switches to that
  workspace and opens the item in one step.
- **Only what the user reads.** The search runs in the user's own scope,
  so the row rules decide what it finds, as on every read: nothing of a
  workspace the user is not in is shown or counted. An Admin user searches
  the workspaces they are in, never a user's private workspace.
- **An empty list** says when the same folder holds items in another of
  the user's workspaces ("2 items in Admin"), with a link that switches
  there.
- A hit opens in the current workspace when that reads it, else in the
  item's home when the user is in it, else in the first of the user's
  workspaces that reads it, by name.

On the wire: `GET /api/search?ws=<id>` and
`GET /api/tree/:kind/search?q=&ws=<id>&across=1` (folder-tree.md); a
folder page asked with `ws` carries `elsewhere`.

## Items and grants

Open an item and use **Grant Access**. The panel lists the item's home and
every workspace it is granted to, each with a Write switch.

| To do this                       | You need                                                  |
| -------------------------------- | --------------------------------------------------------- |
| Read the item                    | to be a user of a workspace it is granted to              |
| Edit its content                 | Moderator of its home, or a grant with Write on           |
| Add a grant to workspace T       | Moderator of its home and Moderator of T                  |
| Remove a grant from T            | Moderator of its home, or Moderator of T                  |
| Switch Write on for T            | Moderator of its home and Moderator of T                  |
| Switch Write off for T           | Moderator of its home, or Moderator of T                  |
| Open, change or close its link   | to be able to edit it (an app: Moderator of its home)     |
| Close any public link            | to be an Admin user with the users area                   |
| Share it with one contact        | to be an Admin user (its home is not checked)             |
| Delete it                        | Moderator of its home (an app: Admin users too, see Apps) |
| Move it to another home (H to T) | Moderator of H and Moderator of T                         |

- A Moderator of a workspace that is not the item's home edits the item
  only when that grant has Write on.
- For an Admin user, **Add Admin** is the first choice in the panel. It
  needs no switch of workspace for an item they manage.
- An item the caller may not read answers "not found", never "exists
  but no", for every login, Admin users included. An item the caller
  reads but may not change answers "forbidden".
- **Kinds.** Folders, files, notes, pages, tables, apps, formulas,
  drawings, tasks, events and Recall maps can be granted to any workspace.
  Telegram messages are a class of their own: they belong to the workspace
  of the assistant that holds the chat, and a grant of one to any
  workspace is set by hand, never passed on by a folder. Every other kind
  (mail, contacts, journal entries, secrets, saved places and the like)
  lives in the Admin workspace only.
- **Embeds.** Granting a page does not grant what it embeds. The panel
  offers to grant the embeds too, as a step you tick.
- **Public links and contact shares** stay per item. A public link serves
  its item and its served list: a new embed is not served until someone
  ticks it ([sharing.md](./sharing.md)).
- **Memory follows the item.** Passages and facts of an item are read only
  where the item is read.

## The home rule

Every item has exactly one home workspace. The home is set when the item
is made, and only a move changes it.

**Where a new item lands:**

1. In the current workspace, when you moderate it and it can hold the
   kind. This holds for everyone, Admin users too. On the web the current
   workspace is the one picked in the switcher. In a chat it is the
   assistant's workspace. A folder you make the item in then only passes
   its grants.
2. Else, when you make it in a folder you may edit: the folder's home.
3. Else your private workspace. An Admin user has no private fallback:
   the item lands in Admin.

The create dialog shows the home before you save. An MCP create says where
the item landed (`landedIn`).

- **A move** from H to T removes H's grant. The move dialog offers "Keep
  it readable in H" (a grant with Write off). Other grants stay.
- **A copy** (duplicate, page from notes, copy to) is a new item. Its home
  is where you make it, with no other grant. Share it again by hand.
- **An export** (a Word or Excel copy, a built sheet, an app file) is a
  new file at the top of Files, homed by the rule above, and holds only
  what you read. An Admin user's goes to Auto-filed / Exports. The reply
  says where it landed (`landedIn`).
- **Parts of a source** (mail attachments, transcripts, image fragments, an
  app's table export) take their source's home and grants.
- **Synced items with no source** (mail, Telegram, calendar, drive and disk
  sync) take their kind's default, which is Admin.

## Folders

A folder is an item with a home and grants like any other.

- **Placing an item in a folder** (by create or by move) gives the item
  the folder's grants. This is the one automatic grant. The dialog says
  "This will also be visible to: ..." before you confirm.
- To place an item in folder F you may edit F (Moderator of its home, or F
  granted to you with Write on), and you may manage the item.
- A folder passes its grants, never its home. An item in a folder keeps
  its own home.
- When a folder's grants change, the items below it follow. A grant set by
  hand on a child stays when the folder's grant changes.
- **Remove from this workspace** on a grant a child took from its folder
  marks it "Removed here", with **Restore**.
- An item that leaves a folder loses the grants it took from that folder,
  unless a nearer folder or a hand grant keeps them.
- **A folder's counts are yours.** A folder's item count counts only the
  items in it that you read in your current scope: the workspace picked in
  the switcher, or all your workspaces. Its folder count counts the folders
  in it that you read. The picked workspace does not narrow the folders:
  the tree keeps every folder you read, so a folder can show a folder
  count and no item count.
- A folder you read still shows when nothing in it is yours to read: an
  Admin user may share empty folders to give a workspace its structure.

## Assistants and chats

- **One assistant per workspace, one workspace per assistant.** An Admin
  user with the assistants area attaches it on the workspace screen.
- **It reads only its workspace's items**, also when the user who asks is
  in other workspaces. Its memory (digests, facts learned from chat) stays
  in that workspace.
- **It writes only for a user who could do it by hand**: a Moderator of the
  home, or a grant with Write on.
- **With no user** (a heartbeat, a scheduled run) an assistant only reads,
  except the Admin assistant, which acts for the owner.
- **Each user reads only their own chats.** Every user has their own thread
  with each assistant (one per assistant and login). No Admin user reads
  another user's chat, the owner included, and no assistant reads one.
- **An assistant of a workspace other than Admin** takes text only, gets no
  Journal and no "About the user", and is not summarised or reflected on
  when its digest limit is 0. A user who is not an Admin user is held to a
  daily turn cap and token budget (`TEAM_CHAT_DAILY_TURNS`,
  `MANTLE_MEMBER_DAILY_TOKENS`).
- **An assistant with history does not move** to another workspace. Clone
  it for the new one.
- **Helpers and workers** (specialists, summarizer, extractor and the
  others) are system wide. A helper runs in its caller's scope and never
  widens it. Only the Admin assistant reads the entity graph.
- **A helper asked for by a login that is not an Admin user refuses** (fails
  closed, `AgentWorkspaceError`), since W8c: before, the agent's old level
  decided what it read. A responder or assistant in no workspace refuses
  too when no login asks (a heartbeat, a run): it has no workspace to run
  in. Specialists and workers with no login still do system work. On a
  brain not yet on workspaces an admin login's helper runs on the system
  pool and any other login's reads nothing.

The chat details: [conversation.md](./conversation.md) section 6d.

## MCP, API keys and linked brains

**MCP.** Every login gets the same MCP surface at the same connector URL
([mcp-as-a-login.md](./mcp-as-a-login.md)). Each call runs in the calling
login's workspaces: it reads what they hold and changes only what that
login may change. There is no per-login MCP switch.

- A tool that manages the brain needs an Admin user with the matching
  area. A tool the caller may not call is not listed, and a direct call is
  refused too.
- A create tool takes an optional `workspace` (one the caller moderates).
  Without it the home rule applies.
- **A login that is not in the Admin workspace gets no spending tools on
  direct MCP**: web search, images, summaries, crawls, route maps,
  extraction and the tools that run another agent spend on the owner's
  provider keys, so they are not listed. `search_chunks` stays, with its
  paid scoring step off.
- The creates of Admin only kinds (a contact, a journal entry, a saved
  place) are not listed for such a login.

**API keys** (`mtlk_`, [08-api-keys.md](./guide/07-api/08-api-keys.md)).
A key acts as the login that made it, as that login is now. Its access
(read only, or read and write) and its areas only narrow that login.

- Every login types its password to make a key.
- A key lasts at most 90 days. A key that never expires, or lasts longer,
  and a key that names risky tools, need a login in the Admin workspace
  with the keys area.
- A password change, **Sign out everywhere**, an admin's End sessions and
  disabling the login end its keys.
- **On `/api/v1`** a route answers a key as the route it stands for in the
  app answers the key's login: a login outside Admin reads and changes
  there what it may in its workspaces (the item routes), and the routes
  for Admin only (contacts, the journal, table row writes) refuse it.
- **Shared content.** A key may not change the content of a page or a
  note others read: one granted to a workspace other than Admin, or with
  a public link or a contact share. What it embeds would become readable
  to them, and a key cannot confirm that. Its login changes it in the
  app. A linked brain acting as a login is held the same way.
- **API only.** A member key made before every login had MCP was made for
  `/api/v1`. The move to one MCP surface marked it `api_only`: it keeps
  working on `/api/v1`, with the same rights as any key of its login there,
  and `/api/mcp` refuses it. A key made since is never API only. Make a new
  key for MCP.

**Linked brains** (peers, [federation.md](./federation.md)). A peer with
**Acts as** gets the MCP surface as that login, as the login is now. Its
own **Write** switch (default off) and its list of allowed risky tools
narrow it further. Changing **Acts as** turns Write off again. Like a
key, a peer with Write on may not change the content of a page or a note
others read (one granted to a workspace other than Admin, or with a
public link or a contact share): the login changes it in the app.

**Vault keys and destinations.** Pairing a vault key with a host it is
sent to needs the keys area (or the owner). This covers tools that use
`{{secret:...}}` or `{{oauth:...}}`, connectors, integration groups, the
API Console proxy, a mail account's stored password against a new host,
and model routes with a base URL. A tool, group, connector or route
records who paired it, and resolves its key only while that login still
holds the keys area.

## Connectors

A connector (an MCP or OpenAPI connector) is a resource of a workspace,
with its own **Write** tick. An Admin user with the connectors area
attaches it on the workspace screen.

- Every user of the workspace may use its read tools.
- A tool that changes data needs the resource's Write on, the user to be a
  Moderator of that workspace, and a connection that may write.
- Every call is logged with the login (`mcp.connector.read`,
  `mcp.connector.write`). The credential stays in the vault.
- Keep a source with secret parts in the Admin workspace only.
- An app run uses only the connectors attached to every workspace that
  holds the app.

## Telegram

A bot belongs to an assistant, so to that assistant's workspace. A paired
chat belongs to one user. Details: [telegram.md](./telegram.md).

- **Only the user pairs their own chat**, with a code. The bot sends the
  code. Signed in (web, phone or their own MCP client), the user enters it
  in **Settings > Telegram** (or `telegram_pair`). The code shows a preview
  first; the user then confirms it within 10 minutes.
- The user must be a user of the workspace of every assistant the chat
  runs as.
- A Moderator of the bot's workspace, and an Admin user with the users
  area, may block or unpair a chat. Nobody pairs a chat for someone else.
- A turn runs as the chat's user, in the assistant's workspace. A user
  removed from the workspace loses the bot at once.
- The owner is special here: the Telegram inbox tools work on the owner's
  chats, and reminders go to the owner's chats.

## Apps

An app is an item: it has a home and grants like a page.

- **Code.** A Moderator of the app's home builds and edits it.
- **Delete.** Delete an app: its home Moderator, Admin users and the
  owner. It goes to Recently deleted with a snapshot. An app someone
  other than the owner deleted waits there until the owner deletes it
  for good.
- **Data.** A user writes the app's data when they may edit the app: a
  Moderator of its home, or a grant with Write on. While **Informational**
  is on, nobody outside Admin writes the app's data.
- **What an app reads.** Everyone who runs an app shares its database. So
  an app reads only what every workspace that holds it reads. An app that
  only Admin holds runs with the runner's own rights. An app any other
  workspace holds runs the narrower rules for every runner, an Admin
  user's run included. An app that a user outside Admin built runs the
  narrower rules too.
- **Adding a holder** narrows what the app reads and shows the app's data
  to the new workspace. The confirm says both.
- **MCP access** on the app opens its data to the `app_data_*` tools, for
  the users who reach the app ([mcp-as-a-login.md](./mcp-as-a-login.md)).

The rules for writing apps: [app-authoring-guide.md](./app-authoring-guide.md).

## The owner

The owner (the anchor) is the brain's first login. The brain is keyed to
it, so it cannot be deleted. The owner reads and changes what its
workspaces allow, like any user. It is special only where stated:

- **House style, purpose and persona (archetype)** in the profile and in
  onboarding: only the owner sets them.
- **Persona notes**: only the owner's thread with the Admin assistant uses
  them, and only the owner changes them.
- **Telegram as owner**: the inbox tools, and reminders.
- Work that answers no login (a heartbeat, a run, an owner Telegram bot)
  acts for the owner.

## Admin areas

The users of the Admin workspace manage the brain through five areas:

| Area                 | What it opens                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Settings             | brain settings, models, pools and AI workers, runs, traces and pending approvals, sandboxes, the terminal, MCP settings, branding |
| Users and workspaces | logins and invites, every workspace's users, blocking or unpairing any Telegram chat, who opened an app                           |
| Assistants           | assistants, skills, tools, tool groups, Studio, heartbeats, attaching an assistant to a workspace                                 |
| Connectors           | MCP and OpenAPI connectors, peers, mail, calendar and Telegram accounts, attaching a connector to a workspace                     |
| Keys                 | vault keys, secrets and PDF passwords, pairing a key with a host, keys that never expire, keys with risky tools                   |

- Today every Admin user holds every area. Each user's row in the Admin
  workspace can switch an area off (`workspace_users.limits`); no screen
  sets it yet.
- Being an Admin user is management, not reading. An Admin user reads what
  is granted to the workspaces they are in, like anyone. A user's private
  workspace is not granted to Admin.
- Adding a user to the Admin workspace makes the login an admin row, and
  removing them makes it a member row. The role grants nothing by itself.
- A tool that manages the brain runs only for an Admin user with its area,
  and then only its own system tables run on the system pool
  ([mcp-as-a-login.md](./mcp-as-a-login.md)).

## What was removed

- **Levels.** Items, agents and tool groups have no level. The level
  columns are frozen and archived; nothing reads them for access. The
  access popover, folder share levels and embedded levels went with them.
- **Client logins and email-code sign-in** (W8a, migration 0272). Former
  client logins are archived, disabled and revoked, and are never enabled
  again. An invite or a new login on a former client's email is refused.
  The client portal routes answer 410. Details:
  [client-logins.md](./client-logins.md).
- **Per-login MCP switches**, the static login tokens (`mtlmcpk_`) and the
  team chat tools, W7b.
- **Admins reading other users' chats** and the member chat routes, W7c.
- **Review, submit and accept**, team drafts and client requests (W5c),
  and comment threads (2026-10-09).
- **The team portal, team codes and the forum** (earlier, member logins
  Phase 6).
- **The one member home app** for the whole brain (Team admin >
  Settings). Since migration 0276 each workspace has its own landing page;
  the old pick became the Team workspace's home app (when Team holds the
  app). Members who never picked a workspace now land on All my
  workspaces; the Team home app shows after a switch to Team, and the
  browser then remembers it.
- **Automatic Admin grants.** Nothing adds a grant to Admin. To put an item
  in Admin, an Admin user shares it with Admin by hand.
- **The built-in Team workspace** (migration 0286, owner decision
  2026-10-13, which reverses plan Q1). Team is a normal workspace: no
  reserved name, no archive refusal, no Admin users kept as its
  Moderators, no special look rule. A new login no longer joins it, and a
  new brain has none. Nobody becomes a Moderator by themselves: an Admin
  user ticks Moderator, and the one who makes a workspace is its
  Moderator. Where a rule asked for "the Team workspace" it now asks for
  the login's own workspaces: a member's chat with no assistant named goes
  to the assistant of its oldest workspace beyond Admin that has one, and
  the old member home route answers its oldest shared workspace.
  "Shared" means one thing everywhere: a workspace that is neither Admin,
  nor a private one, nor a Former user one (`mantle_ws_any_shared`, used
  by the grant reads and that route). A "holder" is any live workspace
  beyond Admin, private and Former user ones included
  (`mantle_ws_any_holder`): an app run's holders and the app list's MCP
  reach. Both stand on one class of a workspace (`mantle_ws_class`), for
  this brain's workspaces only.
- **The login bridge no longer touches Team** (0286). A login that stops
  being an admin or a member keeps its rows in Team, and in every workspace
  other than Admin; only its Admin row follows its role. A later
  conversion of logins (a client set up again as a workspace, say) removes
  those rows itself, on the workspace screen or by hand.

Clients may come back later as ordinary workspaces, set up by hand: a
workspace with its users in it, like any other.

## Operator notes

- **A brain not on workspaces does not start** (arch A7). This release has
  no rule for one: no level path and no rollback switch. After its boot
  switch the web process asks `mantle_ws_skip_reason()`; a brain on
  workspaces, and a fresh install with no owner yet (it serves its signup,
  and its first owner switches it), start. Any other answer ("clients
  present", or "no workspaces yet" when the boot switch failed) is logged
  with the reason and the web process exits.
- **A brain with former clients** (or client level items) is not switched
  to workspaces at boot. It reports "clients present", and since A7 it
  does not start until it is switched. `scripts/roll.sh` and the updater
  refuse to roll such a box to v0.239.90 or later, so this path is only
  for a box that did not come through that gate. Set its workspaces up by
  hand first, then run the switch by hand in one transaction, as the
  database superuser (EXECUTE on `mantle_ws_migrate_locked()` is revoked
  from PUBLIC), then start the box again:

  ```sql
  BEGIN;
  SET LOCAL mantle.ws_former_clients = 'reviewed';
  -- a large brain: SET LOCAL mantle.ws_switch_budget = '10 minutes';
  SELECT * FROM mantle_ws_migrate_locked();
  -- a row with section 'skip' means nothing was switched: ROLLBACK
  COMMIT;
  ```

  The setting covers former client logins only. Client level items (on
  `nodes`, an `audience`, `inherited_level` or `embedded_level` of
  `client`) still block the switch: clear them first. Before COMMIT, check
  that the result has no `skip` row; one names why the brain was not
  switched. The switch ends in its guard (`mantle_ws_switch_guard()`): any
  read or write gained against the old levels rolls it back. The budget
  and the switch timing, and the roll notes for the switch, are in
  [update-prod.md](./update-prod.md), "Rolling to the workspaces switch".

- **Grant drift.** `pnpm -C server/web workspaces:check` compares the
  derived read columns with the grants and reports drift. It reads only.
- **The audit trail** of who changed users, Moderator ticks, grants and
  resources is `workspace_events`.
- **Database roles and restore**: [access-levels.md](./access-levels.md),
  "Operations".
- **Security overview**: [security.md](./security.md).
