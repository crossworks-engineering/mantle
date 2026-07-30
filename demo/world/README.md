# The world bible — single source of truth for all demo content

Every artifact the generator (P2) emits — every note, email, SOP revision,
table row, journal entry, scripted chat turn — references THIS world and no
other. That referential closure is a **tested invariant** (layer-1 unit
tests): a person, company, project or domain that appears in generated
content but not in `world.json` is a build failure.

## Provenance — statistics in, bytes never

Volume targets and structural shapes in `targets.json` are blended from
surveys of three real brains (2026-07-30): a documentation-heavy dev brain,
an email-bearing personal brain, and a production client brain with heavy
assistant usage (~8k traces averaging 9.4 steps, deep sub-page nesting,
revision-controlled document families). **Only numbers and genre
abstractions travelled** — counts, averages, maxima, and "this kind of
document exists". No text, no titles, no names, no tags from any real brain
appear here or may ever appear in generated content. That rule is
load-bearing: embeddings of real text cannot be scrubbed, and this content
lands on a public URL.

## The world in one paragraph

**Alex Carter** runs **Harbour Labs**, a five-person engineering-design
studio. Three client engagements drive the work: a pump-station telemetry
retrofit for a municipal water utility (**PUMPHOUSE** — the revision-heavy,
procedure-driven engagement), a retail fit-out programme (**STOREFRONT** —
pipeline tables, budgets, schedules), and a microgrid feasibility study
(**ISLAND** — research pages, load-profile data). Internally the studio
keeps a handbook (**HANDBOOK** — nested sub-pages). Alex's personal life
threads through the same brain: restoring a workshop lathe (**LATHE**) and
training for a trail half-marathon (**TRAILRUN**) — because Mantle is a
whole-life brain, and the demo should show that.

## Design rules

- **RFC 2606 domains only.** Company mail lives on subdomains of the
  documentation domains (`@harbourlabs.example.com`,
  `@meridianww.example.org`, …); personal contacts on `example.net`. The
  publish guard (P6) enforces this by shape.
- **Shared vocabulary is the point.** `vocabulary` entries in `world.json`
  are seeded across *types* deliberately — "commissioning" must appear in an
  SOP page, a task, an email thread, a journal entry and a chat turn, so
  search demonstrably returns genuine cross-type hits. Each entry lists its
  intended type-spread; layer-2 tests assert the spread materialised.
- **Dates are offsets, never absolute.** Every timeline anchor is
  `days_from_seed` (negative = past). A fresh seed always looks current.
- **Revision families are first-class.** PUMPHOUSE procedures exist in
  rev A → rev B → rev C chains so the demo exercises supersession /
  content-currency — a real brain's most distinctive retrieval behaviour.
- **Pronouns are stated per person** in `world.json` and generated prose
  must use them consistently.

## Files

| file | role |
|---|---|
| `world.json` | the bible: cast, companies, projects, vocabulary, genres, timeline anchors |
| `targets.json` | per-type volume targets + derived-data minimums; layer-2 tests assert against these |

The generator consumes both; nothing else may define world facts.
