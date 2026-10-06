# Who can use a brain: access tiers

A brain has four tiers of access: Admin, Member, Client and Public. Each tier sees only the items set to its level, and the database enforces it.

## The four tiers

| Tier | Who it is for | What they see | How they get in |
|---|---|---|---|
| **Admin** | You, and any co-owner | The whole brain and every setting | Email and password, on every [way in](01-ways-to-control.md) |
| **Member** | Your team | Items at Team, Client or Public level, their own personal space, and a chat with the team agent. No admin screens. | An invite link, then their own password. Web, desktop, phone app or MCP. |
| **Client** | People at your client company | Items at Client level, their own drafts and requests, and a chat with the client assistant | A sign-in link or an emailed code, no password. Web, phone app or MCP. |
| **Public** | Anyone with a link | The one item behind the link | A link you share. No login. |

A member or client cannot change your brain. When they ask for a change, it comes to you as a request in **Team > Requests**.

## How levels decide what each tier sees

Each item has a level: **Admin**, **Team**, **Client** or **Public**.

- Every new item starts at **Admin**. Only an admin lowers a level, by hand.
- Only workspace items go below Admin: pages, notes, drawings, tables, files, folders, apps and formulas. Email, journal, contacts, secrets, tasks and events stay at Admin.
- Lowering a page also lowers what it shows: its images, embedded files and embedded drawings. A plain link to another item keeps its own level.
- A client sees Client items only, not Public ones. A public item is reachable only by its own link.

Agents and tool groups have levels too. A member chats with the team agent only after you set that agent to **Team** level.

The rules sit in the database, not in each screen. A member or client gets the same answer in Jackdaw, the phone app and MCP.

## Give each tier access

| To give | Do this |
|---|---|
| Admin | **Settings > Logins > Add login**, role Admin. See [Member and client logins](../05-admin/07-logins.md). |
| Member | **Team > Invites**, then set the team agent to Team level once. See [Team and members](../03-using-jackdaw/12-team.md). |
| Client | **Team > Clients > Add client**, then issue a sign-in link. See [Member and client logins](../05-admin/07-logins.md). |
| Public | Share the item to make a link. See [Sharing and federation](06-sharing-and-federation.md). |

Set item levels before you let anyone in. Use **Access** in the header of a page, note, table, file, folder, drawing or app.

## Take access back

- **Settings > Logins**: switch on **Disabled** to end a login and all its sessions at once.
- Turn sharing off on an item and its public link stops at once. **Team > Shared links** lists every live link.

## Next

- [Sharing and federation](06-sharing-and-federation.md)
- [MCP as a login](../07-api/02-mcp-login.md)
