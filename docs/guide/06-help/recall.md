---
title: Recall
toolGroups: [recall-read, recall-write]
---

## Recall

Recall maps are memory maps for agents. A map is a set of **cards** that an
agent walks one at a time, starting at the **entry card**. Each card holds some
knowledge and **options**: signposts to the next card, each with a "use when"
line. A card marked **Prompt** is a reusable procedure that agents find by
meaning.

The left side lists your maps in folders. **New map** creates one with its
entry card. Open a map to use three views:

- **Cards**: edit a card's title, body, "use when" line and options. Drag to
  reorder.
- **Graph**: the map drawn as cards and lines.
- **Revisions**: every change, by you or an agent. **Restore** puts back what a
  change replaced.

A save that would break the map (a card too long, an option that points
nowhere) is refused with a message saying what to fix. If someone else changed
the map since you opened it, the map reloads instead of overwriting them.

Three things only you can do: **Publish** a map so agents can find it, confirm
a card as a prompt, and delete a map.

## Assistant

- "Which Recall maps do we have?"
- "Open the deploy map and summarise the first card."
- "Add a card about the backup procedure to the operations map."

Agents read maps with `recall_index`, `recall_open`, `recall_go` and
`recall_match`. Writing cards needs the Recall authoring group, which no agent
has by default. A map an agent starts stays a draft until you publish it.

## Technical

A map is a `recall` item in the tree; its cards are rows in `recall_nodes`, so
an agent reads one card in one query. Limits: 6,000 characters per card body
and 100 cards per map. Prompts are embedded for `recall_match`, which returns
only confirmed prompts on published maps above a score floor. The last 50
changes per map are kept for restore. Changing a map's slug keeps the old slug
working. More detail: [Recall maps](../04-concepts/04-recall-maps.md).
