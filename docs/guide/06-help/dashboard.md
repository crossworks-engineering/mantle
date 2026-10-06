---
title: Dashboard
toolGroups: [brain-health]
---

## Dashboard

The dashboard shows whether your brain is healthy and what it costs. It does not summarise your content.

- **System vitals**: CPU, memory, disk and database, plus the helper services.
- **Questions for you**: open questions the brain wants answered.
- **Vectors indexed** and **Brain nodes**: how much is stored and searchable.
- **Spend (7d)**: this week's model cost against last week. Click it for the breakdown.
- **Pending review**: tool calls waiting for your approval. Click it to handle them.
- Below: spend and ingest over 30 days, **Brain capacity**, counts by type, and panels for email sync, Telegram, heartbeats and recent failures.

The bottom panels are where a quietly broken background job shows up. **Operator view** opens the Debug screen.

## Assistant

- "How big is my brain now?"
- "Am I close to needing a second brain?"
- "How is retrieval quality looking?"

The assistant reads the same capacity figure as the dial. It cannot act on the dashboard.

## Technical

- **Brain capacity** compares your content with the split policy: watch at 10,000 documents or 100,000 passages, split at 20,000 documents or 250,000 passages. Past that, start a second brain. It is a search-quality limit, not a storage one.
- The dial also shows the weekly retrieval score from the recall evaluation.
- Spend is summed from the cost of each traced model call.
- Tools: `brain_capacity`, `recall_eval`.
