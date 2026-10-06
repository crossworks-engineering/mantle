---
title: Config
---

## Config

Config compares this brain's agents, skills, tool groups and workers with the template the product ships, and shows what differs.

Each item has one of four states:

- **OK**: matches the template.
- **Missing**: a default your brain does not have yet, often from a newer version.
- **Modified**: differs from the template, often because you changed it on purpose.
- **Added**: your own item, not in the template. It is never removed.

Open an item to see **Template** next to **This brain**, then click **Commit changes** to write the template version. **Commit all** does every item at once, except worker model changes, which you commit one by one.

Use it after an upgrade, or when an agent acts oddly. Commit a **Modified** item only if you want to lose your change. If you edit prompts in Studio, commit item by item.

## Assistant

The assistant cannot read or apply config differences. Use this screen.

## Technical

- The template is the system manifest, the one list of default agents, skills, tool groups and workers that a new brain is set up from.
- Your persona is matched even if you renamed it. Only its structure is compared, not its prompt or model.
- On each version upgrade, some syncs run on their own: tool-group membership, skill text, the persona's default groups and any missing specialists.
- Committing a specialist overwrites its prompt, model and settings, and adds missing groups and skills.
- Your content (notes, pages, tables) is never part of this.
