# Team and members

Invite people to sign in to your brain as members, read their chats and handle their requests.

A member signs in with their own login. They read items you set to **Team** level and chat with the team agent. They cannot change your brain. When they ask for a change, it comes to you as a request.

The **Team** screen (under Review) holds all of this.

## Before you start

Members can chat only once the team agent is set to **Team** level, on a new install too. There is no button for it yet. Do it once, either way:

- From an MCP client connected to your brain, run `access_set` with `agent_slug: team-responder`, `level: team` and `drop_groups_above: true`. See [Connect Claude over MCP](../07-api/01-connect-claude.md).
- In **API Console**, send `PATCH /api/access/agents/team-responder` with `{ "audience": "team", "dropGroupsAbove": true }`.

## Invite a member

1. Open **Team > Invites**.
2. Click **Invite by email**, or pick a contact.
3. Click **Create invite** and copy the **Invite link**.
4. Send the link to the person yourself. Jackdaw does not email it.
5. They open it, set a password, and are signed in.

An invite link works once and expires after 72 hours. A new invite for the same person replaces the old link. Revoke an open invite from the same tab.

To disable, change or remove a login later, use **Settings > Logins**. See [Member and client logins](../05-admin/07-logins.md).

## Decide what members see

Members see only items at **Team** level or lower. Set the level with **Access** on a page, note, table, file, folder, drawing or app. See [Pages](06-pages.md) for the levels.

Your email and journal stay out of their answers. To let the team agent read them, open **Team > Settings** and, under **Read posture**, switch on **Expose email & journal**. It asks you to confirm. Leave it off unless you mean it.

## Read member chats

**Member chats** lists each member's thread with the team agent. Each member sees only their own thread. The assistant can read them too: "What has the team been asking about this week?"

## Handle requests

When a member asks for a change ("please add the new pump to the site register"), the team agent files a request, stamped with who asked.

1. Open **Team > Requests**.
2. Read the request and make the change yourself, or decide not to.
3. Type a reply and click **Send reply**, or **Send & mark done**.

The reply appears in the member's chat.

## Review what members shared

Members can write their own items and submit them. **Review** lists what waits for you. Accept an item into the brain, return it with a note, or take it over.

## Other tabs

- **Chat archive**: chats from the retired team portal, read-only.
- **Shared links**: every open link to your items, newest first.
- **Clients** and **What clients see**: client logins. See [Member and client logins](../05-admin/07-logins.md).

## Next

- [Who can use a brain](../04-concepts/05-access-tiers.md)
- [Agents and AI workers](13-agents.md)
- Screen help: [Team](../06-help/team-admin.md)
