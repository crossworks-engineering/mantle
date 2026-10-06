---
title: Peers
toolGroups: [federation]
---

## Peers

Peers are other people's Mantles, and this screen sets what each one may read
from yours. Each brain stays separate; a peer can only ask yours questions
about what you shared with it. A new peer sees nothing.

To connect one:

1. Under **Connect a Mantle**, enter a **Display name** and the peer's
   **Base URL**, then press **Add peer**.
2. Copy **Your token for them**. It is shown once. Send it to the other owner.
3. Paste the token they give you to finish pairing.

Then choose what they see. **Share whole categories** shares every item of a
type (Pages, Notes, Files, Contacts, Tables, Drawings, Events, Tasks),
including ones you add later. Below that you can share single items.

**MCP access** is separate: with **Acts as** set, the peer can use its token on
your MCP endpoint with that login's rights. **Write** stays off unless you turn
it on.

## Assistant

- "Does her Mantle have the insurance renewal date?"
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
