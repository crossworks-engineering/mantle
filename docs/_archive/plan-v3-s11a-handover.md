# Plan v3.2 S11a: the A8 tool cells (history and handovers)

Moved out of the spec (docs/actors.md) when D1 split it: the S11a design
notes as they stood after round 2, then each round's handover. The rule
itself is in the spec, section 12 ("A tool") and section 13.

## The tool cells (S11a)

Every builtin write, and every read that takes an item id (`id`, `*_id`,
`node_id`, `ids`), declares on its policy what the matrix asks of it
(`ToolPolicy.matrix`, packages/tools/src/tool-policy.ts): the guide action
its call is, the argument that names the item and the kinds it takes, or
`{ none: reason }`. A write policy without one does not build; the reads
are checked from their schemas (`packages/tools/src/tool-matrix.test.ts`).
The declaration states intent only: no gate or check reads it (the same
test scans for a read), so it is never a pre-check.

`packages/db/src/matrix/test-support/a8-tool-cells.ts` generates the cells
from the declarations alone: the six roles x the placements x the kinds a
tool takes, at its one action, picked pairwise over tool, role, kind and
placement (salted by the tool's name), and for every write action its
member-negative cells whatever the pick (the outsider and the read grant's
member at the root, writeGrant on the Admin-homed item: a member with Write
on a sibling item). `server/web/server/a8-tool-cells.matrix.test.ts` runs
them through a turn (dispatchTool in the assistant's turn scope) and the
MCP surface (an OAuth connection), in warn and on, judged against the
oracle by the declared action; a refusal to a caller that does not read the
item must be a random uuid's answer, byte for byte. A tool that works on
what is inside an item gets, for each cell, a fresh item with that content
seeded as the superuser in the test database
(`packages/db/src/matrix/test-support/a8-tool-content.ts`: a page's
blocks and draft, a table's workbook with two tabs, a key column, rows and
a snapshot, a file's bytes on disk, a Files folder, an app that builds,
with its data open to MCP, a snapshot or a table export), and its probe
reads that content too (a refused write must change none of it). An
allowed cell that needs a model, the outside or a federated peer
(stubbed: cost safety) is counted and not run (68 of them); its refused
cells run. About 950 cells, about 40 seconds per mode.

`server/web/server/a8-coverage.test.ts` (plain vitest, no database): every
registry kind is in the grid or in `A8_EXEMPT` (by class: the Admin-only
and conversation kinds), every tool with an action has cells, the cells
stay under a size ceiling, and the two pins in
scripts/arch-scoreboard.pins.json hold: `a8Uncovered` (0, only down) and
`a8Exempt` (111: 100 tools declared `none` and 11 kinds; a raise needs a
review line from the final audit). The tool cells found one thing for the
owner, S11a-1 (a8-known-failures.ts): file_create makes the missing
folders of its path, so an Admin user who names the path of a folder they
do not read is refused "not found" while a free path is made: the
refusal is right and no row changes, but the folder's existence shows. Round 2's
seeded content found three more, all the owner's to decide: S11a-2,
app_snapshot_delete deletes an app's snapshot for a caller who may not
change the app's code (a read grant's member at the root, a Write grant's
in the folder; content app-snapshots.ts deleteAppSnapshot asks no right);
S11a-3, app_export files a member's export in the Admin-only auto-filed
folder, so a member who reads the app is refused; S11a-4, app_import
through a Write grant's turn makes the app in the turn's workspace, where
that member is no Moderator, so it is refused.

## S11a handover (the A8 tool cells, round 1, 2026-10-18)

Plan v3.2 S11a, branch feat/s11a-tool-matrix, cut from main at ea671d46b
(v0.300.83).

**Done.** `ToolPolicy.matrix` (tool-policy.ts): required on every write
(a write policy without it fails typecheck), declared on every read taking
an item id; one line per tool in the builtins files, the heartbeat tools and
the MCP surface's write and twin policies. 133 builtins declare an action, 100
`none`. The tool cells (a8-tool-cells.ts, a8-tool-cells.matrix.test.ts),
the kinds coverage cell and the coverage test (a8-coverage.test.ts), the
no-DB declaration test (tool-matrix.test.ts), the budget (a run ceiling of
9000 cell runs in the coverage test, 40 minutes in the matrix test; today
952 cells, about 30 seconds per mode). `sortFailures` takes the tool cells
apart from the surface cells (`tool:` names). arch-scoreboard.ts `--pin`
keeps the two test-measured pins (a small hunk beside P1a's lane).

**Pins.** New: a8Uncovered 0 (only down), a8Exempt 111 (cap: 100 tool
`none` declarations and 11 kinds of A8_EXEMPT, by class). No arch-counts
pin moved.

**Known failures added.** P1 (below on, warn only): 20 tool cells of the
read grant's member's edits through a turn and over MCP (formula, Recall
map, card put and delete, task, note at the root and in a folder, event,
page, table) and folder_describe's 2. S11a-1 (owner's to decide, both
modes): file_create by an Admin user on the path of a folder they do not
read is refused "parent folder not found" while a free path is made, so a
hidden folder's existence shows (4 cells).

**Gates** (workstation, own clone and pg18 container, the test database
migrated as CI does with MANTLE_CHECK_FLOOR=keep): typecheck 0, lint 0,
format 0, docs 0, arch 0, web build 0, unit vitest 0, test:actor-off 0,
test:actor-on 0, test:edit-on 0, test:matrix 0, test:runtime-role (full
config) 0. Full vitest with DB 1: three cells of
server/web/lib/auth/device-tokens.db.test.ts answered 403 under the full
run's load; the file alone passes 30 of 30 (S11a does not touch it).

**Left for round 2.** The allowed cells not run for want of content (the
NOT_RUN counts in the matrix test: blocks, columns, file bytes, a Files
folder, app data open to MCP): a richer fixture per kind would run them.
The crash regex is in a8-tool-cells.ts (A8_GENERIC) and still copied in
a8-surfaces.matrix.test.ts. process_extraction is declared read, after its
itemArgs: a member who reads an item may re-run its extraction (model
spend); the owner may want change there.

## S11a handover (the A8 tool cells, round 2, 2026-10-18)

Rebased onto main 8b3099467 (v0.300.85, D1 and P1a merged): round 1 and round 2
squashed into one commit on the new base; the S11a notes and handovers
moved here from the spec; the spec carries the rule in sections 12 and 13
at 350 lines (actorsMdLines unchanged).

**One A8 measurement.** P1a pinned a8Uncovered 207 and a8Exempt 0 from a
static text count in arch-counts (eslint-rules/rights-counts.mjs: tool
policies with no `matrix` key, registry kinds not named in a literal
A8_EXEMPT). On this branch that count reads 11 and 0: it cannot see the
100 `none` declarations as exemptions nor A8_EXEMPT, which is built from
the registry by class. Kept: S11a's measure (server/web/server/a8-coverage.test.ts,
plain vitest in CI), which runs the cell generator itself over every tool's
policy and schema and the kinds registry: a8Uncovered 0, a8Exempt 111.
Dropped: P1a's duplicate (its two numbers, the helpers that made them and
their tests, its two labels in scripts/arch-scoreboard.ts, its pins and
note); arch-scoreboard.ts keeps both sides' other keys and TESTED_PINS
keeps the two pins on a re-pin.

**Done.**

- The seeded content (`packages/db/src/matrix/test-support/a8-tool-content.ts`):
  every tool that works on what is inside an item names what it needs and
  seeds it, as the superuser in the scratch test database, on a fresh item
  of the cell's kind and placement for each cell (allowed or refused): a
  page with an h1, a paragraph and a draft; a table backed by a workbook
  file with two tabs, a key column, rows and a snapshot; a file's bytes on
  disk (a CSV, a PNG, an app package); a Files folder (a branch under the
  files root, F the file kind's); an app that builds, its data open to
  MCP, with a snapshot or a table export; a formula with an input and a
  target; a card with a use-when line. The workbook file and the app
  package are written through hooks the test hands in, so @mantle/db
  imports nothing above it. A drop folder (Write for the member
  workspaces) is the copy tools' destination.
- A seeded item's probe reads its content too (`a8ContentProbe`: the
  node, table, app rows, snapshots, exports, cards), so a refused write
  that changes content fails its cell.
- The app data tools on a turn are narrowed (they act for a login's own
  MCP connection only: 40 cells over both modes).
- The surface cells import the one crash regex (`A8_GENERIC`).
- The test stubs the app runtime manifest and the object store's
  `putContent` (app_build, app_import).

**Pins.** NOT_RUN (the tool cells' not-run counts) 402 to 68: 64 need a
model or the outside (invoke_agent, extract_from_image, summarize_text,
generate_image, video_ingest, email_page: cost safety), 4 a federated peer
(peer_file_copy). NARROWED gains 40 (the app data turn cells). The run is
3606 tool calls over both modes. a8Uncovered 0 and a8Exempt 111 unchanged;
no arch-counts pin moved.

**Time.** About 42 s in warn and 38 s in on (80 s for the tool cells, the
whole test:matrix about 90 s), against the 40 minute budget cell.

**Known failures added** (a8-known-failures.ts, owner's to decide, no
product code changed):

- S11a-2 (4 cells, both modes): app_snapshot_delete deletes an app's
  snapshot for a caller who may not change the app's code (a read grant's
  member at the root, a Write grant's in the folder). content
  app-snapshots.ts deleteAppSnapshot asks no right and the row goes.
- S11a-3 (4 cells, both modes): app_export by a member who reads the app is
  refused: the export is filed in the Admin-only auto-filed folder.
- S11a-4 (1 cell, both modes): app_import through a Write grant's turn makes
  the app in the turn's workspace, where that member is no Moderator.
- P1 grows by 2 (warn): folder_describe through a turn, now that its item
  is a Files folder; its reason is "changed" now that the probe reads the
  node's data.

**The device-tokens failure** (round 1: three cells of
server/web/lib/auth/device-tokens.db.test.ts answered 403 under the full
run; they pass alone). Main ea671d46b's full run passed it 30 of 30 (that
run failed a different timing cell, first-owner.db.test.ts). On this
branch it passed in two full runs and failed in one (a8fe88d9f): two cells,
"a refresh racing End sessions never leaves a live token" and "the devices
follow a refreshed token, and a sign-out removes them", both where the
test's own Admin user calls `PATCH /api/users/:id` (`signOut: true`) with
its session cookie and the gate answers 403 (the Admin area refused). S11a
touches nothing on that path (the session, the gate, workspaces.ts
requireArea, client.ts). No shared-database test file changes that admin's
seat, the brain's Admin workspace or its limits (checked: every test that
writes workspace_users, workspaces or auth.users on the shared database
names its own rows). Most likely the Admin area lookup under the full
run's load: resolveHttpLogin and loginHoldsArea in server/web/lib/auth/session.ts
answer "no area" (a 403) on any error or a missing anchor, so a transient
failure reads as a refusal. That is product behaviour (fail closed), not a
test bug: reported, not fixed. A task with the 403's body logged would
settle it.

**Gates** (workstation, own clone, own pg18 container s11b_pg on port
55967, max_connections=450, the test database migrated as CI does with
MANTLE_CHECK_FLOOR=keep; head a8fe88d9f on main 8b3099467; the handover
commit after it changes only this file): typecheck 0, lint 0, format 0,
docs 0, arch 0, web build 0, unit (no database) 0, full vitest with DB 1
(4 cells, none S11a's: the two device-tokens cells above,
packages/search/src/scope.db.test.ts ensureConcurrentIndexes and
packages/runtime/src/agent/conversation-trace.db.test.ts; the same suite on
the previous head, df821668d's twin on a77282728, was 0), test:actor-off 0,
test:actor-on 0, test:edit-on 0, test:matrix 0, test:runtime-role (full
config) 0. A re-run of the full vitest is in the final report.

**Left.** S11a-2 to S11a-4 for the owner; process_extraction as in round 1.
