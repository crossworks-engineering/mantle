---
title: Workspaces
---

## Workspaces

A workspace is a group of users. It decides what each person reads and
changes: items shared with a workspace can be read by its users, and its
Moderators change the workspace and its items. A login has no rights of its
own.

The list shows the workspaces you are in (an Admin user sees all of them).
Each card carries its pills: **Admin**, **Moderator** (you moderate it) or
**Archived**. Select one to open its screen. Every workspace uses the same
screen:

- **Name**, **Description**, **Colour and icon** and **Contact** (for
  information only). Built-in workspaces keep their names.
- **Users**, each with a **Moderator** switch. Use **Add a user** to find a
  login and add it. **Remove** takes a user
  out. Only an Admin user turns Moderator on or off.
- **Assistant**: at most one. It reads only the items of this workspace, and
  its memory stays here. Pick **No assistant** to have none.
- **Connectors**: each with a **Writable** switch. On, Moderators can use the
  tools that change data. Off, or for other users, only the read tools work.
- **Landing page**: what users see at **Desk** while this is their current
  workspace. **Desk** is the built-in page; an app the workspace holds can
  take its place.

**New workspace** makes one with a **Name** and an optional **Description**.
You are its first user and a Moderator. Any login may make one.

**Archive workspace** ends it. If items still have their home
in it, move them to another workspace first. Items only shared with it lose
that share, and users who read an item only through it cannot read it after.

The **Admin** workspace is special. Its users manage the brain: settings,
users and workspaces. An Admin user is always a Moderator of it, it keeps its
name, and it cannot be archived. A user added there becomes an Admin user.

People see only the controls their role allows. Anyone else in a workspace
reads the same screen without them.

## Assistant

The assistant cannot change workspaces. Set them up here.

An MCP client can list the workspaces you read with `workspaces_list`, then
name one when it creates an item, to put the item there. It may name only a
workspace you moderate.

## Technical

- The screen reads `GET /api/workspaces` (the list) and
  `GET /api/workspaces/:id` (one workspace), and changes them through the
  same routes. The brain checks every change again.
- Every item has exactly one home workspace. An item is shared by a grant to
  a workspace, and each grant has its own write switch. Items are shared from
  each item's own **Grant Access** panel, not here.
- A workspace with one user is private. Each login starts with its own
  private workspace.
- A connector call is logged with the login (`mcp.connector.read`,
  `mcp.connector.write`). The credential stays in the vault. Keep a source
  with secret parts in the Admin workspace only.
- An Admin user with the settings area also sees **Read posture** at the end
  of the Admin workspace's screen. It no longer changes anything.
- The full model: docs/workspaces.md.
