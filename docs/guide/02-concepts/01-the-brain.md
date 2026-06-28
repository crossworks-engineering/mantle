# The brain — how Mantle remembers

This is the heart of Mantle, explained without the engineering. (If you want the
deep technical version, the developer docs cover it exhaustively — this page is the
"what it means for you.")

## Everything you add becomes memory

Whenever something enters Mantle — an email arrives, you write a note, you drop in
a file, the assistant saves something — it lands in one shared place and the system
**automatically reacts**: it reads the content and turns it into memory. You never
press an "index" button; adding *is* remembering.

For each new item, the brain does four things:

1. **Summarises it** — a one or two line gist, so it can scan a thousand items cheaply.
2. **Makes it searchable by meaning** — not just keywords. Ask about "church work"
   and it finds the sermon, the congregation email, and the pastoral note, even if
   none of them use the word "church."
3. **Extracts facts** — durable statements like *"Don's passport expires June 2030."*
   Facts can be updated or retired as things change, so your memory stays current.
4. **Maps the connections** — it notices the people, places, projects, and
   organisations involved and how they relate, building a **knowledge graph** of
   your life (more below).

## The layers of memory

Mantle's memory is organised the way human memory roughly is — from "what we're
talking about right now" out to "the full archive":

| Layer | What it holds |
|---|---|
| **Persona** | Who the assistant is, and what she's learned about *you* — your preferences, how you like replies, recurring people and projects. |
| **Identity (Journal)** | Who *you* are, in your own words — distilled from your [Journal](../03-using/04-pages-tables-notes-docs.md) and carried into every conversation, so you never have to re-explain yourself. |
| **Recent turns** | The last stretch of your conversation, verbatim. |
| **Conversation digests** | Older conversations, compressed into summaries so nothing important is lost as chats age. |
| **Profile (facts)** | Durable, deduplicated facts about you and your world. |
| **Content index** | A searchable catalogue of every document you own — title, summary, tags, and a meaning-fingerprint for each. |
| **Content store** | The original items themselves — the actual emails, files, notes — kept whole and citable. |

When you ask a question, the assistant pulls the relevant slice from each layer,
reasons over it, and answers. The early layers (who she is, what's true about you)
stay stable; the later ones change with each message.

## Two ways it finds things

The brain searches along **two axes**, and combines them:

- **By meaning ("what's like this?")** — semantic search. Great for fuzzy recall:
  *"things related to my travel plans."*
- **By connection ("what's linked to this?")** — the knowledge graph. Great for
  precise questions: *"who is connected to Don?"* or *"what did this project
  involve?"* It can walk relationships — person → employer → colleagues — the way
  search alone never could.

The killer move is combining them: narrow by connection, then rank by meaning.

## It cites its receipts

Every extracted fact remembers **which item it came from**. So the assistant
doesn't just assert things — it can point you to the email, note, or file behind
each answer. If you edit or delete the source, the memory updates to match. This is
what makes Mantle trustworthy: it's reading your life, not guessing at it.

## It reads more than text

The same memory pipeline handles images and documents:

- **Photos** are described and read (text in the image is OCR'd) so you can ask
  about a whiteboard snapshot or a receipt later.
- **PDFs, Word docs, spreadsheets** are parsed — even scanned PDFs with no text
  layer get read page by page.

So "drop it in and ask about it later" works for almost anything.

## What this means in practice

You stop being your own filing system. You add things in whatever messy way is
convenient, and you retrieve them by *describing* them. The assistant becomes
genuinely useful precisely because it remembers — and because it can prove where
its answers come from.

Next: [Agents, skills & tools](02-agents-skills-tools.md) — how the assistant is
shaped and what she's allowed to do.
