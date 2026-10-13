# Who can use a brain: workspaces

Every person who uses your brain has a login. A login gives no rights by itself. What a person reads and changes comes from the workspaces they are in.

## The model

- A **workspace** has a name, users, at most one assistant, and connectors.
- Each user of a workspace has a **Moderator** tick.
- An item is shared by a **grant** to a workspace. Each grant has a **Write** switch.
- Every item has one **home** workspace.
- The users of a workspace read every item granted to it. They change an item when its grant has Write on, or when they are a Moderator of its home.
- A workspace with one user is private.

You set permissions in two places only: **Settings > Workspaces**, and the **Grant Access** panel of each item.

## The workspaces you have

| Workspace | Who is in it | What it is for |
|---|---|---|
| **Admin** | You and the other admins | Running the brain: settings, logins, workspaces, assistants, connectors, keys |
| **Your private workspace** | Only you | Your own work. Nobody else sees it, admins included |
| Any other | The users a Moderator or an admin adds | A team, a project, a group, a company you work with |

Admin is the only workspace with rules of its own: it keeps its name and cannot be archived. A brain set up before October 2026 also has a **Team** workspace; it is a workspace like any other now.

Any user may make a new workspace. They become its only user and its Moderator. Only an admin ticks **Moderator** for anyone else, or removes a Moderator from a workspace.

## Share an item

1. Open the item and click **Access** to open its Grant Access panel.
2. Under **Share with**, pick a workspace. You must be a Moderator of the item's home and of that workspace.
3. Leave **Write** off to let its users read only. Turn it on to let them edit.

Nothing is shared by itself, with one exception: an item you put in a folder gets the folder's grants. The dialog tells you who will see it before you confirm.

**Public** links stay per item. A link opens one item for anyone who has it, with no login. See [Sharing and federation](06-sharing-and-federation.md).

## Assistants and chats

Each workspace can have one assistant. It reads only that workspace's items, and it changes an item only for a user who could change it by hand. Each user reads only their own chats: no admin reads another user's chat, you included.

## Add people

| To add | Do this |
|---|---|
| A member | **Settings > Logins > Invite**. They get their private workspace only. Add them to the workspaces they need on **Settings > Workspaces**. |
| Another admin | Add them to the Admin workspace, or **Settings > Logins > Add login** with role Admin. |
| Someone outside your company | Make a workspace for them, add their login, and share only what they need. |

Client logins and emailed sign-in codes are gone. A former client login stays disabled.

## Take access back

- Remove the user from the workspace. They lose its items at once.
- Turn a grant's **Write** off, or remove the grant.
- **Settings > Logins**: switch on **Disabled** to end a login and all its sessions.

## Next

- [Sharing and federation](06-sharing-and-federation.md)
- [Add logins](../05-admin/07-logins.md)
- [MCP as a login](../07-api/02-mcp-login.md)
- Deep developer reference: [workspaces.md](../../workspaces.md)
