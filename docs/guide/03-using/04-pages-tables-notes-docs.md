# Notes, Pages, Tables & Docs

Five surfaces for writing and structured content. They range from "scribble a
thought" to "build a typed database," and all of them feed the brain — plus
**Journal**, the first-person channel for teaching the assistant who you are.

## Notes — fast capture

**Notes** are quick markdown jottings. This is the lowest-friction way to put
knowledge into Mantle: open Notes, type, done. A note is summarised, embedded, and
mined for facts the moment you save it. Use it for ideas, snippets, meeting scraps —
anything you want findable later. (The assistant can create notes for you too:
"make a note that…")

## Journal — who you are

**Journal** are short, first-person notes about *you* — what you do, who's in
your life, what you're working towards, and how you're feeling — each tagged with
a **mood** and a **life area** (work, family, faith, health, …). Keep them small
and honest: a sentence or two per entry.

They're different from Notes in one important way: alongside being searchable like
everything else, your Journal are distilled into an **always-on identity
context** the assistant carries into *every* conversation. So once you've logged
"I run CrossWorks and I'm building Mantle" or "I'm a father of three," you never
have to re-explain — the assistant already knows who it's talking to. The more you
log, the better it understands you.

The assistant can add entries for you, too: "log that I started a new job today,"
"remember that I've been feeling stretched this week." Open **Journal**, click
**New**, write a line, pick a mood and area, save.

## Pages — rich documents

**Pages** are Notion-style documents for real writing: headings, **callouts**,
**asides** (gradient note boxes), multi-**column** layouts, tables, to-do lists,
code blocks, even math and images.
The editor has a slash menu (`/`) for inserting blocks and a drag handle for moving
them. Moving from Notion? **Copy a page as Markdown and paste it straight in** —
headings, callouts, columns, tables and Notion's `<aside>` callouts all convert
to real Mantle blocks.

A few things worth knowing:

- **Draft vs publish.** Typing autosaves a *draft* continuously; the page is only
  re-indexed into the brain when you **commit** it. So editing is cheap and
  indexing is deliberate — a long writing session costs one indexing pass, not
  hundreds.
- **Mentions & links.** Type `@` to link people, entities, or other pages — these
  become real connections in your knowledge graph.
- **Sub-pages.** Pages can nest, so you can build a small wiki.
- **AI-assist.** Open the assist panel and ask the **Pages** specialist to
  restructure, reformat, or expand a document; it edits a draft you review before
  committing — your words are never silently rewritten.
- **Share.** Any page can be turned into a read-only public link (see
  [sharing] below).
- **Deep search.** Long pages are indexed in sections, so the assistant can find the
  *specific passage* you need, not just the whole document.

The assistant can also create and update pages from chat — "turn this thread into a
polished page" — and the result renders identically to one you wrote by hand.

## Tables — typed data grids

**Tables** are a lightweight Airtable/Notion-database: typed columns (text, number,
currency, date, checkbox, select, formula…), per-row data, **totals**, and
**formulas** (same-row expressions like `{Qty} * {Price}`). You can **import**
spreadsheets (`.xlsx`/`.csv`) — each sheet becomes a table.

Like Pages, Tables use draft/commit (edits autosave, committing re-indexes), and
there's an **Assist** panel backed by a tables specialist ("Ledger") that can add
columns, write formulas, set totals, categorise rows, and tidy data — editing a
draft you commit when happy. The committed table (including its totals) is indexed,
so the assistant can answer questions about the data.

## Docs — read-only documentation

**Docs** is a read-only viewer for documentation that's been **indexed into the
brain** — including this very User Guide. It's grouped by collection. Unlike Pages
(which you author in-app), Docs are markdown files on disk that get synced in; the
viewer just renders them. You manage which collections are indexed — and add your
own — under [Documentation collections](../04-configuring/05-documentation-collections.md).

Because docs are in the brain, the assistant can answer "how does X work?" by citing
them — that's how Saskia can explain Mantle itself.

## Which one should I use?

| Use | Surface |
|---|---|
| Jot a quick thought | **Notes** |
| Record something about yourself so the assistant knows you | **Journal** |
| Write a structured document, report, or plan | **Pages** |
| Track rows of data, do sums/formulas, import a spreadsheet | **Tables** |
| Read reference docs the assistant can cite | **Docs** |
| Store an existing file (PDF, image, your own .md) | **[Files](03-files.md)** |

[sharing]: ../05-technical/03-federation-and-sharing.md
