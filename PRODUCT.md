# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: one person, one life.** A single owner running Mantle for their own
email, files, journal, tasks, contacts and secrets. When the three audiences
below conflict, this one wins.

One brain per install, one owner. Additional logins are *ways in*, not tenants:
every login sees the same data and is a full admin, distinguished only by the
audit trail.

Confirmed but secondary:

- **A team's working memory** — shared notes, pages, tables and files, with
  scoped share links and Mantle-to-Mantle federation.
- **A company knowledge base behind an MCP chatbot** — documentation and
  internal know-how, queried by MCP clients over ~30 tools.

**How the owner uses configuration** (confirmed, and load-bearing for
navigation): the owner revisits a *small handful* of configuration screens and
opens the remaining ~20 rarely or never. Configuration is not one population
with one frequency; it is a short head and a long tail, and design should treat
them differently rather than as a single block.

## Product Purpose

A self-hosted AI brain where **the memory substrate is the product** and chat is
one doorway into it. Everything ingested (email, files, notes, conversations,
contacts, calendar) flows through one pipeline into a typed, owned data model
with layered memory: persona, recent turns, digests, profile facts, a content
index, and the original content store.

It is also **awake**: heartbeats run agent routines on a schedule, ingestion
pipelines feed it without prompting, and it acts in the background rather than
only answering when asked.

Success is an assistant that picks up where the owner left off with no sessions
and no "new chat", cites the source of every fact it states, and completes work
nobody explicitly asked for.

## Positioning

Autonomous **and** safe to leave running, on hardware the owner controls. The
combination is the claim a neighbouring product cannot truthfully copy:

- Ingested content is treated as **data, never instructions**, so an autonomous
  brain reading an inbox is not a prompt-injection lever.
- Self-hosted with no SaaS in the runtime path; the database on the owner's
  server is the single source of truth.
- **One Postgres, no zoo** — vector search, knowledge graph, full-text, job
  queues, realtime and auth in one database, which is why the whole system
  restores from a single dump and idles at roughly 2.5 GB RAM.

## Operating Context

The owner UI is a web app. The same brain is also reached through a desktop
wrapper, through Telegram by text or voice note, and by MCP clients. All of them
address one brain and one memory.

The owner UI is a **zero-secret client**: it holds no session secret and no
database access, and fetches every screen over HTTP from the server origin.
Enforcement is the server's 401s, not a client-side gate.

The shell frames content with a header, a left navigation rail, a right activity
column, and two optional right-hand panels (an assistant dock and a help rail).
Each rail subtracts from the content area, and most screens are themselves
master-detail with a list column plus a detail pane. Horizontal space is
therefore contended, and navigation chrome competes directly with working space.

## Capabilities and Constraints

- **50 primary navigation destinations** across five groups. Settings alone is
  24 of them, and a further group holds a single item.
- Typed content kinds: pages, tables, notes, journal, life logs, tasks, events,
  contacts, files, documentation, secrets, formulas, and generated apps.
- Agents, skills, tool groups and workers are declared by a **system manifest**
  that is the single source of truth; nothing is hardcoded in seeds or runtime.
- Secrets are sealed with AES-256-GCM and the extraction pipeline is
  structurally unable to read a secret's payload.
- **The repository is public.** No client names, hostnames, IP addresses, or
  personal data may appear in shipped code, docs, content, or commit messages.
  Seeded and default content stays name-agnostic.
- **The sidebar is the product's map.** Seeing the full list is how a user
  learns what exists, so rarely-used destinations may be collapsed but must not
  be removed from it.

Existing navigation machinery that future work must preserve or deliberately
replace, not break by accident:

- Icon-rail collapse for both side rails, persisted in cookies and published as
  CSS custom properties that every framing element offsets against.
- A **live badge** on the pending-approvals destination, driven by realtime
  events. A count that exists to be noticed cannot move somewhere it is hidden
  by default.
- A command palette that **already searches navigation destinations as well as
  content**, and a separate sidebar filter box that duplicates part of that job.
- Per-destination **usage counts** recorded on every visit and currently spent
  only on a footer quick-menu.
- Per-screen help: one help document per navigation destination, with a test
  that fails when the route map, the files, and the navigation list disagree.

## Brand Commitments

- The product name is Mantle. The default assistant persona keeps its shipped
  name; personas are otherwise name-agnostic.
- Inter is the UI body font everywhere. The wordmark and the header page title
  use a display font the user selects from a shipped library.
- Colour comes from generated theme seeds across roughly 40 themes. Theme colour
  is never hand-authored, and fills are always paired with their own foreground
  token.

## Evidence on Hand

- `README.md` and `docs/guide/` carry the product story, the memory
  architecture, and the trust boundary in the product's own voice.
- `docs/guide/06-help/*.md` is the per-screen help corpus, one file per
  destination, each with a fixed three-section structure.
- A changelog corpus under `docs/_changelog/` records shipped behaviour by
  version.

No customer testimonials, benchmarks, pricing, or third-party press exist in the
repository. Future work must not fabricate them.

## Product Principles

1. **Memory is the product.** Any surface earns its place by making the brain's
   contents easier to reach, trust, or act on.
2. **One owner, one brain.** Do not introduce tenancy, permission tiers, or
   private areas by implication. Accountability comes from the audit trail, not
   from access control.
3. **Autonomous, but bounded.** Capability that acts on the owner's behalf ships
   with its boundary visible: confirm-gates, allowlists, and sealed payloads are
   product features, not friction to design away.
4. **The map stays visible.** Rarely-used capability may be quiet, but a user
   must still be able to see that it exists without knowing its name.
5. **Frequency beats taxonomy.** What the owner actually uses is measured, not
   guessed. Prefer surfacing observed behaviour over inventing a cleaner
   category scheme.

## Accessibility & Inclusion

No formal standard has been set by the owner. Established in code and treated as
the working floor:

- Every fill colour is paired with its own foreground token, and a lint rule
  rejects fill colours used as text after one theme measured 1.05:1.
- Interactive elements carry visible focus rings and accessible names; icon-only
  controls in collapsed rails expose their label through a tooltip and an
  accessible name rather than the icon alone.
- Native dialog and alert primitives are used for confirmation rather than
  browser prompts, so focus handling and escape behaviour are consistent.
