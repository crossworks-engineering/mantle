# Getting started

This is the five-minute tour: sign in, meet the assistant, add your first piece of
knowledge, and watch the brain react. You don't need to understand the internals
to use Mantle — just talk to it and feed it things.

> Don't have Mantle running yet? Set it up first — see [Installation](01-installation.md).

## 1. Create your account

Mantle is single-user. The first time you open the app you'll see **Create your
account** — pick an email and password. (This first-run signup is only available
while no account exists; after that it becomes the normal sign-in. Sessions last
a long time, so you rarely log in again.)

Signing up drops you straight into the **onboarding wizard**, which gets the
brain ready: it collects a model key (and optional voice/vision keys), sets up
your assistant and its background workers, runs a quick health check, asks a few
questions so the assistant knows who you are, and lets you choose its
personality and voice. See [Onboarding](../onboarding.md) for the full tour.
You can change anything it sets up later under **Settings**.

## 2. Meet the assistant

The assistant (her default name is **Saskia**) is the front door to your brain.
Two ways to talk to her:

- **Web** — open [Assistant](03-using/01-assistant-and-telegram.md) in the sidebar.
  Type a message, attach an image or document, or use the mic to dictate. Her
  replies can come back as nicely formatted documents.
- **Telegram** — once your phone is paired (see
  [Assistant & Telegram](03-using/01-assistant-and-telegram.md)), message her like
  any contact, including **voice notes**. She'll transcribe what you say and can
  reply out loud.

It's the *same* assistant with the *same* memory on both — there are no separate
conversations to keep in sync.

Try: **"Hi — what can you help me with?"**

## 3. Add your first knowledge

Anything you add becomes part of the brain. The easiest starting points:

- **Write a note** — go to **Notes**, jot something down (e.g. a project idea).
- **Upload a file** — drag a PDF or document into **Files**.
- **Just tell the assistant** — "Make a note that the gate code is 4821" or "Add a
  todo to renew the car licence" and she'll create it for you.

Within moments, the system reads what you added: it writes a short summary,
indexes it for search, pulls out key facts, and notes the people/places/projects
it mentions. You don't trigger any of this — it happens automatically.

## 4. Ask for it back

Now the payoff. Ask the assistant about what you just added — even vaguely:

> "What was that note I made about the gate?"

She searches your memory, finds it, and answers — and can show you the source.
This **recall** is the whole point: you add things once and find them by meaning,
not by remembering where you filed them.

## 5. Connect your real life (optional, recommended)

To make Mantle genuinely useful, connect a few sources:

- **Email** — add an account under **Settings → Accounts**. Mantle never ingests
  mail you didn't ask for: your **Contacts** are the gate, so only mail from
  people you've added flows into memory (and **Discover** helps you find senders
  worth adding). See [Email & inbox](03-using/02-email-inbox-and-contacts.md).
- **Telegram** — pair your phone so the assistant reaches you anywhere.
- **API keys** — add at least one model provider key under **Settings → API keys**
  so the assistant and the background indexing can run. (Embeddings run locally and
  free by default.)

## Where things live

- Things you create and the assistant: **Assistant**, **Notes**, **Pages**,
  **Tables**, **Todos**, **Events**, **Contacts**, **Secrets**, **Files**.
- Incoming email: **Inbox**.
- Configuration: everything under **Settings**.
- "What did the system just do?": **Traces** and **Debug** (for the curious).

A one-line description of *every* menu item is in the
[Menu reference](03-using/00-menu-reference.md).

## Next

- [The brain](02-concepts/01-the-brain.md) — how memory and recall actually work.
- [Agents, skills & tools](02-concepts/02-agents-skills-tools.md) — what the
  assistant can be taught and allowed to do.
