# The world bible: single source of truth for all demo content

Every artifact the generator emits (every page, note, email, table row,
journal entry, chat question) references THIS world and no other. That
referential closure is a tested invariant (layer-1 tests in
`demo/generator/test`): an email address that appears in generated content
but not in `world.json` fails the build.

## The world in one paragraph (v2, 2026-10-07)

**Alex Carter** runs **Harbour Labs**, a three-person engineering studio,
with **Tessa Okafor** (controls and telemetry) and **Rowan Mercer**
(mechanical and energy). Their one client is **Meridian Waterworks**:
**Gordon Bekker**, the plant superintendent who approves every procedure
revision, and **Lena Marsh**, the SCADA technician who witnesses the loop
checks. Two projects run at the same station, Pump Station 3 (PS3):
**PUMPHOUSE**, the telemetry retrofit (a changeover procedure issued as
rev A, then rev B, loop checks, a commissioning window a week after seed
time), and **ISLAND**, the standby power study that started the night the
PS3 diesel failed to start (can the station ride through a four-hour outage
on solar and a battery?). Five people, two projects, one story: every item
in the demo belongs to it.

Main allows one client company per brain (client logins), which is why both
projects are Meridian's.

## Design rules

- **Small and polished.** Three to six items per workspace, each one worth
  opening, each one pointing at the others. `targets.json` pins the numbers.
- **The four sharing levels, the same way everywhere.** Every workspace that
  can share has a Private, a Team and a Client folder, and one item at the
  top level with an open link (public). The look of the three folders is
  `access.folders` in `world.json`; `generator/content/folders.mjs` builds
  them.
- **Embeds stay in their tier.** A page or note embeds images from the Files
  folder of its own level, so a share never reaches through an embed into
  another folder. Mentions may point at anything the item's readers can read.
- **RFC 2606 domains only.** The studio on `harbourlabs.example.com`, the
  client on `meridianww.example.org`. The publish guard enforces this by
  shape.
- **Shared vocabulary is the point.** `vocabulary` entries are spread across
  node types on purpose ("loop check" is in a page, a note, a task, a table
  and an event), so search returns real cross-type hits.
- **Dates are offsets, never absolute.** Every anchor is `days_from_seed`, so
  a fresh seed always looks current.
- **Pronouns are stated per person** and generated prose uses them.
- **House style.** No em dashes, and no en dash as a sentence break.

## Files

| file | role |
|---|---|
| `world.json` | the bible: cast, companies, projects, vocabulary, timeline, folder look |
| `targets.json` | per-type volume targets; `verify.ts` asserts against these |
| `art/` | the twenty illustrations (JPEG), `art.json` (title, level, date) and `prompts.md` (how they were made) |

The generator consumes these; nothing else may define world facts.
