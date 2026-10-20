# Who can use a brain: workspaces

Every person who uses your brain has one login. A login opens nothing by itself: what a person reads and changes comes only from the workspaces they are in.

## One gate for every way in

The app, MantleOS Desktop, the phone app, Telegram, MCP, an API key and a public link all come in through the same gate. The gate works out who is asking (a person, a key, an assistant, a link or another brain) and passes the request on under that name. The database then decides what that name may read and change.

So the rules are the same everywhere: a person gets the same answer in the app, on the phone and over MCP. Work that runs later, such as an approved action or a scheduled run, is checked again with the person's rights at the moment it runs.

## The model

- A **workspace** is a group of people: a team, a site, a project or a client. It has users, at most one assistant, and connectors.
- Every item has one **home** workspace. It is shared with another workspace by a **grant**, and each grant has its own **Write** switch.
- People read every item shared with their workspaces. They change an item when its grant has Write on, or when they are a **Moderator** of its home.
- An item you may not read looks like it does not exist.
- A workspace with one user is private.

You set who sees what in two places only: **Settings > Workspaces**, and the **Access** panel of each item.

## The workspaces you have

| Workspace                  | Who is in it                           | What it is for                                                                |
| -------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| **Admin**                  | You and the other admins               | Running the brain: settings, users, workspaces, assistants, connectors, keys  |
| **Your private workspace** | Only you                               | Your own work. Nobody else sees it, admins included                           |
| Any other                  | The people a Moderator or an admin adds | A team, a site, a project, a company you work with                           |

Admin is the only workspace with rules of its own: it keeps its name, cannot be archived, and every admin is always one of its Moderators. To make someone an admin, add them to Admin. Running the brain is not reading it: an admin reads only what is shared with the workspaces they are in.

A brain set up before October 2026 also has a **Team** workspace. It is a workspace like any other now.

Anyone may make a new workspace. They become its first user and its Moderator. Only an admin turns **Moderator** on or off for someone else, or removes a Moderator.

## Nothing is shared by itself

No item is shared unless someone shares it. The one exception: an item you put in a folder takes the folder's workspaces, and the dialog tells you who will see it before you confirm.

A public link is separate: it opens one item for anyone who has the link, with no login. See [Sharing and federation](06-sharing-and-federation.md).

## Assistants and chats

Each workspace can have one assistant. It reads only that workspace's items, and it changes an item only for a person who could change it by hand. Each person's chats are their own: nobody else reads them, admins and the owner included.

## Next

- [Workspaces and people](../03-using-jackdaw/12-team.md): make a workspace, add people, share an item
- [Sharing and federation](06-sharing-and-federation.md)
- [Add users](../05-admin/07-logins.md)
- Deep developer reference: [workspaces.md](../../workspaces.md) and [actors.md](../../actors.md)
