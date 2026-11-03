---
title: Peers
toolGroups: [federation]
---

## Peers

Peers are other people's MantleOS brains, and this screen sets what each one may read
from yours. Each brain stays separate; a peer can only ask yours questions
about what you shared with it. A new peer sees nothing.

Two brains link with two tokens, one for each direction. To link one:

1. Press **Link a brain**. Under **Their brain**, enter a **Name** (only you
   see it) and their **Address**, then press **Add brain**. If they already
   linked you, paste **Their token (if you have it)** too.
2. Copy **Your token for them**. It is shown once. Send it to the other
   owner, with this brain's address shown on the screen.
3. When their brain shows a token for you, open the link and paste it under
   **Their token**. Neither side has to go first.

Lost your token for them? Open the link and press **New token for** (their
name). The old token stops working at once. The **Connection** switch turns a link off
without removing it.

Then choose what they see. **Share whole categories** shares every item of a type (Pages, Notes, Files,
Contacts, Tables, Drawings, Events, Tasks), including ones you add later.
Below that, **Search an item to share** shares single items.

**Tools (MCP)** is separate. **Acts as** is **Nobody (share only)** at
first. Set it to **Owner (admin)** or a member login, and the peer can call
this brain's tools with that login's rights. Choosing the owner makes a new
token for them. **Write** stays off unless you turn it on. Even with Write
on, a peer (like an API key) may not change the content of a page or a note
others read: one granted to a workspace other than Admin, or with a public
link or a contact share. Change those in the app. **Risky tools allowed**
is only for a peer that acts as the owner, at most 64 tools, and most links
need none.

## Assistant

- "Does her brain have the insurance renewal date?"
- "Ask the accountant's brain for last year's filing."

Answers come from the peer's data as it is now, and say which peer they came
from. If the peer removes a share, the next question returns nothing.

## Technical

Each peer has two tokens, one per direction. The token they gave you is sealed
with your master key; for the token you gave them, only a hash is kept.
Removing a peer stops both tokens and drops every share. A question inside
what you shared is answered without asking you, so the share list is the
whole boundary. Every request from a peer is written as a `federation_request`
trace.

The assistant uses `peer_list`, `peer_query`, `peer_search_chunks`,
`peer_node_get` and `peer_tools`. More detail: [Sharing and
federation](../04-concepts/06-sharing-and-federation.md).
