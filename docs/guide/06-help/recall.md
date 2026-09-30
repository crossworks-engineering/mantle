---
title: Recall
toolGroups: [recall-read, recall-write]
---

## Recall

Memory maps for agents. A map is a small set of **cards** an agent walks one
at a time: each card holds a piece of knowledge plus **options**, signposts
that say where to go next and when ("use when …"). Every map starts at its
**entry card**. A card can also be a **prompt**: a reusable procedure agents
find by meaning.

This screen is the map editor. The left side is the Recall tree: your maps,
filed in folders (up to three deep). **New map** creates one with its entry
card already written. Open a map to work on it in three views:

- **Cards** lists the cards in order (drag to reorder) and opens one to edit:
  its title, body (up to 6,000 characters), its "use when" line, the
  **Prompt** switch, and its options. An option leads to another card in the
  map, or to another published map's entry card.
- **Graph** draws the map as cards and edges, with the entry marked and cards
  no option leads to flagged. Hover or focus an edge's chip for the full
  label and its "use when" line; **Labels / Dots / Off** sets how much a
  dense map shows at once.
- **Revisions** is the log of every change, yours and agents', with who made
  it. **Restore** puts back what that change replaced.

Every save is checked as it is made. A card over the size cap, an option that
points nowhere, or a prompt without a "use when" line is refused with a
message that says what to fix, so an agent never reads a broken map. If the
map changed since you opened it (an agent, or another tab), the save is
refused and the map reloads, rather than overwriting their change.

Three things are yours alone. **Publish** makes a map visible to agents; a map
an agent starts waits here as a draft until you publish it. **Prompt** status:
an agent can only ask for it, and the card shows the request until you confirm
it; until then it never matches. And deleting a map. If an agent changes the
words of a confirmed prompt, it goes back to waiting for your confirm.

A map's slug is what agents and skills remember. Renaming a map keeps its
slug; changing the slug is a separate step in the map's settings, and the old
slug keeps working.

## Assistant

- "Which Recall maps do we have?"
- "Open the fleet map and summarise the box-by-box card."
- "Add a card for the deploy procedure to the running-mantle map."

Agents read maps through `recall_index`, `recall_open`, `recall_go` and
`recall_match`. With the Recall authoring tools (`recall-write`, in no agent's
default grant) an agent can add and edit cards and start a draft map; the
change is logged in Revisions and serves at once. An MCP client on your token
also has the owner tools (publish, confirm a prompt, reorder, restore, change
a slug, delete), and uses them only when you ask in the conversation.

## Technical

A map is one `recall` item in the tree; its cards are rows in `recall_nodes`,
written directly and checked in the same transaction, so an agent read is one
indexed row with no compile step. Caps: 6,000 characters per card body, 100
cards per map. Prompts are embedded (768-dim) for `recall_match`, which only
returns confirmed prompts on published maps above a score floor. Every write
carries the map's version, and the last 50 changes per map are kept for
restore. Maps built from tagged pages (Recall v1) were retired in R5; `recall`
and `prompt` are ordinary page tags now.
