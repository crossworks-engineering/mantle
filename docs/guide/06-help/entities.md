---
title: Entities
toolGroups: [memory-core]
---

## Entities

Entities shows people, places and organisations that were extracted twice under different names, so you can merge them.

- **High confidence** pairs are backed by evidence, such as "Example Ltd" and "Example Limited", or an address that matches a contact. These are safe to merge.
- **Needs your eye** pairs only look alike by name. Check them first.
- Click **Merge** to fold one into the other, or **Not a duplicate** to stop seeing that pair.

A duplicate splits someone's history in two, so "what do I know about Sam?" misses half the answer.

## Assistant

- "What do I know about Example Ltd?"
- "How is Sam connected to the pump project?"

The assistant can read entities and their links. It cannot merge them. Merging happens only on this screen.

## Technical

- A merge moves every fact and link to the kept entity, adds the other name as an alias and deletes the duplicate, in one step. It cannot be undone.
- Dismissed pairs are remembered and not suggested again.
- Tools: `entity_search`, `entity_facts`, `entity_mentions`, `entity_neighbors`, `graph_path`.
