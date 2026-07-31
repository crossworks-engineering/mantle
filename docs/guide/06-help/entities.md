---
title: Entities
toolGroups: [curation]
---

## Entities

Where duplicate people, places and organisations get merged back together.

Entities are extracted automatically from everything that arrives, and
extraction cannot always tell that "Sam Delport", "S. Delport" and "sam@acme.com"
are one person. This screen surfaces the pairs it suspects and asks you.

Merging matters more than it looks. An entity is what ties a person to every
mention of them across mail, notes, events and files — so a duplicate doesn't
just look untidy, it splits someone's history in half and makes "what do I know
about Sam?" return the wrong answer with no sign anything is missing.

## Assistant

- "Have I got Sam recorded twice?"
- "Merge those two supplier records."

Dismissing is as useful as merging. Two genuinely different people with the same
name will keep being offered as candidates until you say they're distinct, and
a dismissal is remembered.

## Technical

Candidates come from name similarity combined with shared attributes — an email
address or phone number in common raises confidence considerably, which is why
the strongest suggestions tend to involve contacts.

A merge repoints every fact, mention and edge from one entity onto the other and
removes the empty one, inside a single transaction. It's not a display-level
alias: after a merge there is one entity, and retrieval that used to return half
the history returns all of it.

That also makes a merge hard to undo, which is the reason this is a review queue
rather than something extraction does on its own confidence. The cost of a wrong
merge — two people's records fused — is much higher than the cost of a duplicate
sitting around for a week.

Dismissals are recorded per pair, so the same suggestion doesn't return after
the next extraction run.
