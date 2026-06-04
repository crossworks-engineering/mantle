# Menu reference

Every item in the sidebar, with one line on what it's for and a link to a deeper
guide where one exists. The aim here is *orientation* — "what is this screen?" —
not a click-by-click tour.

## Workspace

| Item | What it's for |
|---|---|
| **Dashboard** | The home overview — recent activity, system health, spend, and memory-index stats at a glance. |
| **Inbox** | Your ingested email, organised by account/folder. See [Email & inbox](02-email-inbox-and-contacts.md). |
| **Assistant** | Chat with the assistant on the web — text, voice dictation, image & document uploads, richly formatted replies. See [Assistant & Telegram](01-assistant-and-telegram.md). |
| **Files** | A real folder tree of your files, mirrored to disk. Upload, browse, edit text files; everything is read into memory. See [Files](03-files.md). |
| **Notes** | Quick markdown notes. The fastest way to drop knowledge into the brain. |
| **Life Logs** | Short, first-person notes about who you are, what you do, and how you feel (with a mood + life-area). Teaches the assistant who you are: they're distilled into an always-on identity context it carries into every conversation. See [Pages, Tables, Notes & Docs](04-pages-tables-notes-docs.md). |
| **Pages** | Rich, Notion-style documents (headings, callouts, tables, columns, to-dos). For real writing. See [Pages, Tables, Notes & Docs](04-pages-tables-notes-docs.md). |
| **Docs** | Read and navigate all documentation straight from disk (works even without indexing), and manage which collections are indexed for the assistant. Includes this User Guide. |
| **Tables** | Typed data grids (like a lightweight Airtable): columns, formulas, totals, import from spreadsheets. |
| **Todos** | Tasks with status, priority, and due dates. |
| **Events** | Calendar events with reminders that ping you on Telegram. Supports recurring events. |
| **Contacts** | People you know — name, company, one or more emails (or `@domain` wildcards), phone, and an AI-facing description. The allowlist for email in **both** directions: whose mail is ingested *and* who the assistant may email. See [Contacts](05-todos-events-contacts-secrets.md). |
| **Secrets** | An encrypted vault for passwords, codes, and credentials. The assistant can search descriptions but never sees the sealed values. |

## Review

| Item | What it's for |
|---|---|
| **Models** | A read-only explorer of every AI provider's catalogue — models, pricing, context windows, capabilities. |
| **Discover** | A live scan of your mailbox for recent senders who *aren't* in your contacts yet — one click adds any as a contact (which starts ingesting their mail). The way you find new people worth keeping now that contacts are the gate. See [Email & inbox](02-email-inbox-and-contacts.md). |
| **Pending** | Actions the assistant queued that need *your* approval before they run (for tools you've marked as requiring confirmation). |

## Settings

| Item | What it's for |
|---|---|
| **Appearance** | Light/dark mode and colour theme. |
| **Accounts** | Your email accounts (IMAP/SMTP) — add, configure folders, enable sending. |
| **Profile** | Your name/avatar, timezone, and locale — so the assistant resolves "tomorrow at 3pm" correctly. |
| **API keys** | Provider keys (OpenRouter, OpenAI, Anthropic, Google, etc.) the assistant and workers use. |
| **Agents** | Configure the conversational assistants — persona, model, primary/backup routes, voice, tools, skills. See [Agents & workers](../04-configuring/01-agents-and-workers.md). |
| **AI workers** | Configure the background jobs — extractor, summarizer, reflector, text-to-speech, speech-to-text, vision, image generation. |
| **Embedding** | The model that powers meaning-based search. Runs locally and free by default. |
| **Local network** | Connect Mantle to model machines on your own network (via Tailscale) so a cloud server can reach a model box at home. |
| **Tools** | The catalogue of actions agents can take, and which ones require your approval. See [Skills & tools](../04-configuring/02-skills-and-tools.md). |
| **Skills** | Reusable know-how you can attach to agents. |
| **Heartbeats** | Proactive, scheduled behaviours. See [Heartbeats](../04-configuring/03-heartbeats.md). |
| **Entities** | The people/places/projects the brain has identified — review and merge duplicates. |
| **Peers** | Connect to *another* person's Mantle and exchange specific, granted items (federation). |
| **PDF passwords** | A vault of passwords so the system can read your password-protected PDFs. |
| **Security** | Change your password. |

## System

| Item | What it's for |
|---|---|
| **Traces** | A detailed log of every unit of work — each assistant turn, each extraction — with steps, cost, and timing. The "show me exactly what happened" view. |
| **Debug** | A set of operational dashboards (overview, spend, topics, digests, facts, agents, telegram, **Journey**, **Integrity**) for understanding and auditing the brain. For the curious and for troubleshooting. |

## Other surfaces

- **Pending** (also in Review) — the approval queue for gated tool calls.
- **Node history** — most items have a "history" view showing everything the brain
  did with them (summary, facts, graph links). Reached from an item, or via Traces.
