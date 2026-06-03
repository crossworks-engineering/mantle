# Mantle — your own AI brain

Mantle is a **self-hosted AI brain**: one private place that remembers your whole
life — emails, files, notes, documents, photos, conversations — and an assistant
that can actually *use* what it remembers. You talk to it like a person; it
answers from everything you've ever given it, and it can cite exactly where each
answer came from.

It runs on **your** machine. No SaaS in the loop, no third party holding your
data, no monthly seat. The database on your server is the single source of truth,
and you own every byte.

---

## Why Mantle is different

Most "AI assistants" forget you the moment a chat ends. Mantle is built the
opposite way: **memory is the product.**

- **It remembers everything, and never makes you repeat yourself.** There are no
  sessions to start or threads to manage. You mention your "Lister gantry rebuild"
  once; weeks later you say "that printer project" and it knows. Conversations are
  continuous — you pick up wherever you left off.

- **It cites its receipts.** Every fact it tells you traces back to the email,
  note, or file it came from. The assistant doesn't hallucinate your life — it
  reads it. When it says "your passport expires in June," it can show you the
  document that says so.

- **It has a real memory architecture, not a bigger prompt.** Under the hood,
  everything you add is distilled into layered memory — short-term conversation,
  long-term facts, a searchable index of every document, and a **knowledge graph**
  of the people, places, and projects in your life and how they connect. See
  [The brain](02-concepts/01-the-brain.md).

- **It comes to you.** Talk to it in the web app, or over **Telegram** from your
  phone — by text *or voice note*. It transcribes what you say and can reply out
  loud. Same assistant, same memory, wherever you are.

- **It's proactive when you want it to be.** Standing instructions called
  *heartbeats* let it check in, follow up, and run recurring routines on its own —
  then stop when the job's done.

- **It reads what you throw at it.** Forward an email, drop a PDF invoice, snap a
  photo of a whiteboard — Mantle ingests it, extracts the text (OCR included), and
  files it into memory so you can ask about it later.

- **You choose the models — local or cloud.** Run everything on a local model on
  your own hardware for total privacy and zero per-token cost, or use a frontier
  cloud model, or mix the two with automatic failover. Embeddings run locally and
  free by default.

---

## What you can do with it

- "What did the plumber quote me last month?" → finds the email, gives you the number.
- "Summarise everything I know about the church renovation." → pulls notes, emails, and people involved.
- "Remind me to call Don on Friday at 3pm." → creates the event, pings you on Telegram when it's due.
- "Take last week's meeting note and turn it into a polished page." → drafts a rich, formatted document.
- "Draft a reply to this and send it." → composes and sends from your own mailbox.
- Drop in a scanned invoice → "What's the total and due date?" → reads the PDF and tells you.

---

## Who it's for

Mantle is a **single-user** system, built for one person who wants a private,
durable, queryable record of their life and work — and an assistant that treats
that record as its memory. It's self-hosted by design: if you can run a small
server (or even a spare box at home), you can own your own brain.

---

## Where to go next

- **New here?** Start with [Getting started](01-getting-started.md).
- **Want to understand the magic?** Read [The brain](02-concepts/01-the-brain.md).
- **Configuring the assistant?** See [Agents, skills & tools](02-concepts/02-agents-skills-tools.md).
- **Looking for a specific screen?** The [Menu reference](03-using/00-menu-reference.md) explains every item.
