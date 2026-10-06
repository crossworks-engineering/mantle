---
title: Studio
---

## Studio

Studio shows how one agent is wired: its skills, the agents it hands work to,
and the exact prompt its model receives. Use it when an agent behaves oddly and
no single settings screen explains why.

- Pick an agent in the header selector. The canvas shows its skills and
  delegates; click a delegate to move to it. **Health** and **Workers** are
  views in the same selector.
- The inspector lists the agent's model, role, tools and delegates, and the
  **Composed prompt**: its own prompt plus each attached skill, in order.
- Edit the prompt or a skill's text in place. Each save is a new version;
  **History** shows a diff and reverts in one click.
- Change the model, settings, skills and delegates. **Reset to default** puts
  a built-in agent back to how it shipped.
- The sandbox runs a test conversation against the composed prompt. It saves
  nothing and runs no tools, so you can try a prompt change safely.

## Assistant

The assistant has no tools for Studio. Ask it how Studio works, then make the
change here:

- "How is an agent's composed prompt put together?"
- "What does Reset to default change on an agent?"

## Technical

The canvas is drawn from the live database rows, not from the shipped
defaults, so it shows your brain as it is now. The **Health** view runs the
config-integrity checks against the system manifest and flags what differs.
Studio writes the same agent rows as Settings > Agents. Text versions are kept
in `prompt_versions`, one history per agent prompt or skill, so the history
survives model changes and regrants.
