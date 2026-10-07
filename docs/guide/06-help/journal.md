---
title: Journal
toolGroups: [journal]
---

## Journal

The Journal holds short entries that tell the brain who you are and what you want. Agents carry them into every conversation.

It has three views:

- **You**: your own entries. Each has a kind: Identity, Context, Preference or Goal.
- **Agent notes**: what agents have learned while working (lessons and expectations).
- **Questions**: open questions the brain wants you to answer. Answer one and it becomes part of what the brain knows about you.

Click **New** to write an entry. Title, date and tags are optional. Search and filter by kind or tag.

## Assistant

- "Journal: I prefer short replies with the answer first."
- "Remember that my goal this year is to finish the workshop build."
- "What open questions do you have for me?"

## Technical

- Entries are `journal` nodes, indexed for search like other content.
- Your entries are distilled into an "About the user" block. Agent notes and open questions become a "Working notes" block. Both are added to agent prompts.
- The distillation is a fixed selection of real entries, with no model call, so it costs nothing extra per turn.
- Tools: `journal_list`, `journal_get`, `journal_create`, `journal_update`, `journal_resolve_gap`. Deleting needs `journal_delete`, which is in a separate admin group.
