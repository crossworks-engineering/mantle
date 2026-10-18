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

Rebased onto main a77282728 (v0.300.84, D1 merged): round 1 and round 2
squashed into one commit on the new base; the S11a notes and handovers
moved here from the spec; the spec carries the rule in sections 12 and 13
at 350 lines (actorsMdLines unchanged).

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
run). Not reproduced: main ea671d46b's full run passed it 30 of 30 (that
run failed one other timing cell, first-owner.db.test.ts "stops the
process after a short delay"), and this branch's full runs passed it 30 of 30. S11a touches no file on its path. No cause found in the test (it uses
the shared database with its own logins; the box modes and seats it reads
are not changed by any shared-database test file); left as an intermittent
one, not fixed.

**Gates.** See the commit's final report (the CEO's reply) for the exit
codes of the run on this head.

**Left.** S11a-2 to S11a-4 for the owner; process_extraction as in round 1.
