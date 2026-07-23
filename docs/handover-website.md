# Handover — the Mantle marketing site

> **For a fresh session.** Build the public marketing website for Mantle.
> This brief carries everything: the stack mandate, the brand assets and
> where they live in this repo, the canonical copy (already written), the
> numbers you may claim and their provenance, a proposed page structure, and
> the honesty rules. The author of this brief has full context of the
> architecture; the site builder should not need to re-read the codebase.

## 1. The mission

A **slick, engaging landing page that gets right to the bones**: Mantle is a
self-hosted AI brain — a system with genuinely no like-for-like competitor —
and the page must make that felt within one screen. Not a feature grid with
stock gradients; a confident product story: the brain is the product, it
never forgets, it builds a personality around you, it targets context
surgically, and it runs for cents on hardware you own.

Documentation links point at the future public repo:
**https://github.com/crossworks-engineering/mantle**
(live since 2026-06-11 — it IS the canonical repo now; use it everywhere).

## 2. Stack mandate

Same framework family as Mantle itself:

- **Next.js 15 (App Router)** + **Tailwind v4** + shadcn-style primitives.
- **Theming with themes** — not just light/dark. Mantle ships **42 color
  themes** (tweakcn presets) as `[data-color-theme="<id>"]` CSS-variable
  override blocks; the site should reuse that exact system. A theme picker
  on the site is itself a product demo — Mantle's own UI has one, including
  a "random theme" rotation.
- Decide at session start whether the site is a **standalone repo** (own
  deploy cadence — recommended) or `apps/site` in the monorepo. Either way,
  lift the assets below rather than re-inventing them.

## 3. Brand assets — exact locations in this repo

| Asset | Where | Notes |
|---|---|---|
| **Wordmark font** | `apps/web/public/fonts/BukhariScript-Regular.ttf` | The logo is the word **`mantle`** (lowercase) set in Bukhari Script — the "plain font" logo, no icon. Loaded via `next/font` `localFont` in `apps/web/lib/fonts.ts` as `--font-logo` → `font-logo` utility. **Bukhari is used ONLY for the wordmark** (and the app's centered page title); everything else is Inter. |
| **Body font** | `apps/web/public/Inter/` (variable TTFs) | Inter everywhere for the UI, loaded in `lib/fonts.ts`. Don't change the body font. |
| **Display fonts** | `apps/web/lib/display-fonts.ts` + `public/fonts/library/` | User-selectable **wordmark + page-title** fonts (Settings → Appearance → Fonts). One registry drives the lazy `@font-face` block, both pickers, and the runtime CSS-var override (`--font-wordmark` / `--font-page-title`). Persisted like the colour theme (`profiles.preferences.fontLogo`/`fontTitle`). Add one: face → `public/fonts/library/<key>.ttf` + a registry row. |
| **Theme registry** | `apps/web/lib/themes.ts` | 42 themes with `{id, label, swatches}` — swatches drive picker previews. Default `clean-slate`. |
| **Theme CSS** | `apps/web/app/globals.css` | Baseline tokens in `:root`/`.dark`; every other theme is a `[data-color-theme]` block (83 blocks incl. dark variants). Portable — copy wholesale. |
| **Theme plumbing** | `apps/web/components/theme-provider.tsx`, `color-theme-provider.tsx`, `theme-toggle.tsx`, `random-theme-toggle.tsx` | next-themes for light/dark + a data-attribute setter for color themes. |
| **Styling rulebook** | `docs/ui-style-guide.md` + `apps/web/CLAUDE.md` | The non-negotiables: **theme tokens only, never hardcoded colors** (that's what makes 42 themes work), every fill paired with its own `-foreground`, shadcn-first, Tailwind v4 no dynamic class names. These rules apply to the site too — it's the same design system. |

## 4. The copy — already written, don't re-derive it

**`README.md` on main is the canonical marketing copy**, written deliberately
to seed this site. Its structure maps one-to-one onto landing sections:

1. **Hero** — "A self-hosted brain for everything you know." + the two
   intro paragraphs (the "drop a PDF / that gantry note from April" beat).
2. **The brain is the product** — chat-window-amnesia contrast + the
   six-layer table + graph + lossless recall. This wants the page's one big
   visual: the six layers as a living diagram, not a screenshot.
3. **Who it's for** — three personas: one person's life · a team's working
   memory · a company's docs behind an MCP chatbot ("your support bot stops
   hallucinating and starts citing your actual docs").
4. **Why it's different** — eight blocks, in order: genuinely yours →
   one Postgres, no zoo → **builds a personality around you / never
   forgets** → **context that targets the question** → engineered to be
   cheap → agents with jobs → nothing happens without a trace → it knows
   who you are (Journal).
5. **Quick start** — the 5-line snippet, CTA to the GitHub repo.
6. **The doorways** — web / Telegram / MCP / share links / federation.
7. **Footer** — license (see §6) + Cross Works Engineering.

Lines worth keeping verbatim (they tested well in the writing):

- *"There is no 'new chat'. There is one relationship that compounds."*
- *"The brain is the product — chat is just one doorway into it."*
- *"One Postgres, no zoo."*
- *"A newsletter can never crowd out a real letter."*
- *"The model sees a small, surgical prompt instead of a haystack."*
- *"Every ranking knob has a measured eval number behind it, not a vibe."*
- *"What it observes, it learns; what you declare, it never has to guess."*

Voice: confident, concrete, first-principles. No "revolutionary", no
"supercharge", no emoji. The product's credibility IS the marketing — say
what it does mechanically and let that be impressive.

## 5. Numbers you may claim, with provenance

Claim ONLY these, phrased as measured-on-production, not as guarantees:

| Claim | Source |
|---|---|
| **~$0.09** average per full Q&A turn against the whole brain | prod measurement, `docs/audit-chat-cost-2026-06-07.md` (avg $0.089, p50 $0.076) |
| **Under $5/month** total LLM spend in real daily use | same doc — $3.83 over 30 days, all trace kinds |
| **$0 embeddings** — computed locally, vectors never leave the box | bundled Ollama EmbeddingGemma, `docs/embeddings.md` |
| **Six memory layers**, all live | `docs/memory.md` |
| **~30 MCP tools** | `docs/architecture.md` §10 |
| **42 color themes** | `apps/web/lib/themes.ts` |
| **One Postgres** — vectors, graph, FTS, queues, realtime, auth | `docs/architecture.md` §4 |
| **1,349 automated tests** | `pnpm exec vitest run` on main (re-run for the current number before publishing) |
| Restores from **one `pg_dump`**; scheduled backups built in | `docs/backups.md` |

## 6. Honesty rules — do not cross

- **One brain per install.** Mantle is single-user by design ("one brain per
  install — a life, a team, a product"). Never imply multi-tenant SaaS.
- **License**: dual — public **FSL-1.1-MIT** (free to use/self-host/modify,
  not for Competing Use; converts to MIT after two years) + a commercial
  license (`licensing@crossworks.engineering`). The footer must state this
  plainly; `LICENSING.md` has approved plain-language phrasing.
- It is **self-hosted software**, not a hosted service. The CTA is "run it",
  not "sign up".
- Voice/vision/image features depend on the operator's own provider keys —
  fine to show, don't imply they're free.
- No invented benchmarks, logos, or testimonials.

## 7. Design direction

- The wordmark in Bukhari against theme-token backgrounds is the whole logo
  treatment — lean into it. Big, lowercase, confident.
- The theme picker in the site header is the cheapest "show, don't tell" on
  the page: the visitor restyles the entire site live, exactly like the
  product.
- One hero visual that explains the system: content flowing in (email, file,
  voice note, chat) → the six layers → answers flowing out of the doorways
  (web/Telegram/MCP). Animate it subtly if it stays cheap; never at the cost
  of load time.
- Dark mode first-class (next-themes), since the audience is developers.
- Performance is part of the message: a marketing page for a lean system
  must itself be lean. Static-render everything; no client JS beyond the
  theme picker and small interactions.

## 8. Links

| Destination | URL |
|---|---|
| Repo + docs CTA | https://github.com/crossworks-engineering/mantle |
| Docs deep-links | `https://github.com/crossworks-engineering/mantle/blob/main/docs/<file>.md` |
| Licensing contact | licensing@crossworks.engineering |

The site itself needs hosting + a domain — ask Jason at session start
(nothing is provisioned yet).

## 9. Open questions for Jason at session start

1. Standalone repo or `apps/site` in the monorepo? (§2 — recommended:
   standalone.)
2. Domain + hosting target for the site?
3. Screenshots: the real app makes good ones (themed dashboard, /assistant,
   the Journey view, /traces) — take them from a seeded dev brain, or keep
   the site illustration-only for v1?
