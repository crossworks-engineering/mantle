---
title: Shared links
toolGroups: [page-share, sharing]
---

## Shared links

This screen lists every share link that works right now, so you can see at a
glance what people outside the brain can open. Anyone with a link can view its
item, with no login.

The list is newest first. Each card shows the item's title, the date it was
shared, its kind and how many times it was viewed. A link made for one contact
says so: "For" that contact "only", and "can write" when they may change the
app.

Select a link to see a preview on the right. The preview is the real shared
page, so it shows exactly what a visitor gets. The header has three icons:

- **Copy link** puts the address on your clipboard.
- **Open link** opens it in a new tab.
- **Revoke link** turns it off. The item stops being reachable at once; the
  item itself is not changed. Press **Keep sharing** to back out.

To share something new, use the Share button on any page, note, table, app,
task, event, file or folder. When nothing is shared, the screen says so.

A link is not how your team reads items. Users read items through their
workspaces, with their own logins ([Workspaces](workspaces.md)).

## Assistant

The assistant can share an item or turn its link off, when its agent holds the
sharing tools. Making a link always asks you first, because it publishes the
item.

- "Share the onboarding page and give me the link."
- "Turn off the public link to the budget table."

## Technical

- The list comes from `GET /api/team-admin/shares`, which needs the users
  area. Each row is one active link, at `/s/<token>`.
- There is one link per item. It shows the item plus what it names, embeds or
  holds, but only the parts on its served list.
- Only someone who may edit an item can share it. An app or a Present canvas
  can be shared only by a Moderator of its home workspace.
- A contact share opens with that contact's code. Revoking it takes the link
  from that contact only; workspaces do not change.
- Tools: `page_share` and `page_unshare` for pages, `node_share` and
  `node_unshare` for every other kind. More: docs/sharing.md.
