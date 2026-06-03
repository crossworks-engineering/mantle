# Agents, skills, tools & heartbeats

Four concepts shape what the assistant *is* and what she can *do*. Understanding
them is the key to making Mantle work the way you want. They build on each other:

> **Agents** are the assistants. **Tools** are the actions they can take.
> **Skills** are the know-how they can be taught. **Heartbeats** let them act on
> their own schedule. **Delegation** lets one assistant hand work to a specialist.

## Agents — the assistants

An **agent** is a configured assistant: a name and personality, a chosen model
(local or cloud), a set of tools it's allowed to use, and skills it's been taught.
The two you'll meet by default:

- **The responder** — answers on Telegram (this is "Saskia").
- **The assistant** — the web `/assistant` chat. Same brain, different doorway.

Each agent has its own ongoing conversation but **shares the one brain** (the
memory, facts, and graph). You can run more than one agent, and even create
specialised ones. Configure them under **Settings → Agents**. See
[Agents & workers](../04-configuring/01-agents-and-workers.md).

There's also a quieter population working behind the scenes — **AI workers** — that
do one-shot jobs: summarising, extracting facts, transcribing voice, reading
images. You don't talk to them; they keep the brain fed. They're configured under
**Settings → AI workers**.

## Tools — what an agent can do

By itself an agent can only talk. **Tools** let it *act*: search your memory, read
a file, create a note or todo, schedule an event, send an email, generate an
image, look something up on the web, and more.

You control which tools each agent may use (its allowlist), and tools you consider
risky can require **your approval** before they run — those queued actions show up
under **Pending**. Manage the catalogue under **Settings → Tools**. See
[Skills & tools](../04-configuring/02-skills-and-tools.md).

## Skills — what an agent knows how to do

A **skill** is reusable know-how, written once and attached to an agent — like a
short playbook added to its instructions. Examples: how to write richly formatted
documents, how to interview you to learn your preferences, house style for replies.

Skills keep personalities lean: instead of one giant prompt, an agent composes the
skills it needs. A skill can also carry the tools it requires, so attaching the
skill grants those tools too. Manage them under **Settings → Skills**.

## Heartbeats — acting on a schedule

By default the assistant is reactive — it waits for you. **Heartbeats** make it
proactive. A heartbeat is a standing instruction with a schedule, a memory, and a
stop condition: "check in once tomorrow," "every Monday, run my weekly review,"
"keep nudging until I've answered."

Heartbeats remember state across runs and **end themselves** when their goal is
met, with quiet-hours and cool-down guards so they're never pestering. Set them up
under **Settings → Heartbeats**. See [Heartbeats](../04-configuring/03-heartbeats.md).

## Delegation — assistants that call specialists

An agent can hand a focused task to another agent and use the result. This is how
the front-door assistant stays simple while still being powerful — it delegates to
specialists:

- **Remy** replays what was *actually said* in past conversations (lossless recall).
- **Researcher** searches the live web and returns a cited answer.
- **Pages** restructures and formats long documents.
- **Docs** answers "how does this work?" from the documentation (including this guide).

You don't manage delegation day to day — the assistant decides when to call a
specialist. You just see a better answer (and, if you look in **Traces**, exactly
who did what and what it cost).

## Putting it together

When you ask the assistant something, it: reads the relevant memory, decides
whether it needs a tool or a specialist, takes the action (asking your approval if
required), and replies — learning a little about your preferences as it goes. Skills
shape *how* it does this; tools bound *what* it can do; heartbeats let it start the
conversation itself.

Next: jump into [using the assistant](../03-using/01-assistant-and-telegram.md), or
browse the [menu reference](../03-using/00-menu-reference.md).
