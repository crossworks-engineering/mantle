# Sharing and federation

Nothing leaves your brain unless you send it out on purpose. Every item starts private, and each way out is scoped to what you chose and can be taken back.

## Access levels

Each item in your workspace has a level:

| Level | Who reads it |
| --- | --- |
| **Admin** | You and other admins. Every new item starts here. |
| **Team** | Your member logins too |
| **Client** | Your client logins |
| **Public** | Anyone with its link |

Only an admin lowers a level, by hand. Only workspace items (pages, notes, drawings, tables, files, folders, apps and formulas) go below Admin. Email, journal, contacts and secrets never do.

Lowering a page also lowers what it shows: its images, embedded files and embedded drawings move to the same level. A plain link to another item does not.

## Public links

Share an item and Mantle makes a link anyone can open without a login. Turn sharing off and the link stops working at once. **Team > Shared links** lists every live link.

To show one item to one outsider without a public link, share it with a contact. The contact opens it with a code you give them.

## Federation

Federation links your Mantle with someone else's Mantle. Each brain stays its own; they answer each other only within what each side granted.

- You add the other brain under **Settings > Peers** and swap tokens.
- You grant single items, or a whole kind (for example all pages, including pages you make later).
- Secrets are never shared. Email and journal can only be granted one item at a time.
- Revoking the peer closes both directions at once.

A peer can also connect over MCP as one of your logins ([MCP as a login](../07-api/02-mcp-login.md)).

## Example

Your partner runs their own Mantle. You pair the two brains and grant them your "Holiday plans" page. Their assistant asks yours, "what are the flight times?" Your brain answers from that page only. Everything else in your brain stays invisible to them.

## Next

- [Team and members](../03-using-jackdaw/12-team.md)
- [Member and client logins](../05-admin/07-logins.md)
- Deep developer references: [access-levels.md](../../access-levels.md), [sharing.md](../../sharing.md), [federation.md](../../federation.md)
