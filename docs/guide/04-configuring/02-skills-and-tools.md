# Skills & tools

These two screens control what the assistant *can do* and *knows how to do*. Read
[Agents, skills & tools](../02-concepts/02-agents-skills-tools.md) first for the
concepts; this page is how to manage them.

## Settings → Tools

Tools are the concrete actions agents can take — search memory, read a file, create
a note/task/event, send email, generate an image, search the web, and many more.
Some are built-in; you can also add your own (e.g. an HTTP call to a service you
run).

For each tool you control:

- **Whether it requires your approval.** Mark anything consequential (sending email,
  deleting) as **requires confirmation**. When an agent wants to use it, the action
  is queued under **Pending** for you to approve or reject — nothing happens behind
  your back. Routine, safe tools run immediately.
- **Availability.** Which agents may use a tool is set per agent (its allowlist on
  **Settings → Agents**), so a tool existing doesn't mean every agent can use it.

### Approving queued actions (Pending)

When a gated tool is invoked, it lands in **Pending**. Open it, inspect the exact
arguments (e.g. the email it wants to send), then **approve** (it runs and the
result is recorded) or **reject**. This is your safety valve for letting the
assistant act without giving it free rein.

## Settings → Skills

A skill is reusable know-how — a short playbook attached to an agent's instructions.
Rather than one bloated personality, an agent composes just the skills it needs.

A skill can also **carry the tools it requires**, so attaching the skill grants
those tools to the agent in one step. Examples of what skills encode:

- How to write richly formatted documents (so chat replies and Pages look great).
- A house style for replies.
- An interview routine to learn your preferences.

You can create, edit, enable/disable, and attach skills here, then assign them to
agents on **Settings → Agents**.

## How they work together

When you ask the assistant something, its **skills** shape *how* it responds, and
its **tools** bound *what* actions it can take. A request like "email Don the
meeting summary" might use a writing skill to draft well, then a `send email` tool —
which, if you've gated it, waits for your approval in **Pending**.

## Good defaults

- Keep **send**, **delete**, and other irreversible tools set to **require
  confirmation** until you trust a workflow.
- Grant each agent only the tools it actually needs.
- Use skills to teach behaviour you find yourself repeating in prompts.

Next: [Heartbeats](03-heartbeats.md) for proactive, scheduled behaviour.
