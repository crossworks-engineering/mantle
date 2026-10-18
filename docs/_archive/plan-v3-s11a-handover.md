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

**Left.** S11a-2 to S11a-4 for the owner; process_extraction: settled by the owner (S11a-8).

## S11a handover (the A8 tool cells, round 3, 2026-10-18)

Rebased onto main ab0ce298a (v0.300.86: S3, D1 and P1a merged), then onto
7a7608fb1 (v0.300.88: the snapshot-delete hotfix and the bare fetch test's
fix); both sides' pin keys kept (S3's gapTables and dbClientLines beside
a8Uncovered and a8Exempt). The audit at c54b6ad4a rated the tool cells 7/10.

**Done.**

- Both checks in each mode (H1): the tool cells set the actor check and
  the edit check together (warn and warn, on and on), as every box runs
  them. Before, the edit check stayed off.
- An allowed cell for every tool (M1): the generator picks one positive
  cell per tool whatever the pair pick (a candidate the oracle allows on
  every way in it takes, salted by the tool's name), and a tool is covered
  only with an allowed and a refused cell (the coverage test asks both).
  The matrix test fails a tool that runs no allowed cell, or passes none, in
  a mode; a tool whose allowed call needs a model, the outside, a sandbox or
  a peer is counted in NOT_RUN instead, and a tool whose every allowed cell
  is a known failure is named in ALLOWED_KNOWN_ONLY (it leaves when its
  finding is fixed). New fixtures: a draft for table_commit, a committed
  workbook for table_snapshot_create, the app's own database with an a8
  table for app_db_seed and app_table_export_set, a fresh item per cell for
  export_node (its export is named after the item). invoke_agent gets the
  turn's agent context (its target agent is one the test makes);
  generate_image a prompt of three characters or more. The model stays
  stubbed.
- Member-negatives for every write (M2): keyed on the tool's effect, so a
  copy, an import or an export (which declares the read of its source) gets
  them; a refused write of that kind must make no node (the probe adds the
  brain's node count).
- The moves (M3): file_move, folder_move, tree_item_move and page_move
  declare the guide's move, the destination a folder homed in T (made once
  per tree root, a8-tool-content.ts a8MoveTarget); sandbox_import declares
  the read of its file, sandbox_create of its inbox folder (their allowed
  calls need sandboxd: NOT_RUN). app_snapshot_delete declares edit, the
  product's rule (the HTTP route's); the library's own check is the hotfix
  branch's (feat/hotfix-snapshot-delete), not this one's.
- The disk probe (M4): a seeded item's probe hashes its table's workbook
  file and its draft's (with their write-ahead logs) and a file's bytes on
  disk, so a refused write that changed a file first fails its cell.
- One tool list (L1): server/web/server/a8-tools.list.ts, read by the
  coverage test and the matrix test. a8Exempt is pinned by name too
  (A8_EXEMPT_TOOLS and A8_EXEMPT_KINDS in the coverage test).
- The no-read scan (L2) also sees `['matrix']`, `'matrix' in`, and a
  destructuring (`{ matrix }`, `{ matrix: m }` before `=` or as a
  parameter), comments stripped; a cell of the test checks each pattern.
- The budget (L3): 210 s for the tool cells (about three times the 70 s they
  take on the workstation); the CI comment says what test:matrix runs now.
- app_import and app_duplicate through a turn (S11a-4 dropped): a new app
  needs manage of its create home, and a turn's create home is the turn's
  workspace, so a turn whose login is no Moderator of its workspace is
  narrowed with that reason (6 cells).

**Pins.**

| Pin            | Before                                                             | After                                                                              |
| -------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| NOT_RUN        | 68 (stubbed 64, peer 4)                                            | 84 (stubbed 68, sandbox 8, peer 8)                                                 |
| NARROWED       | 198 (app data 40, Admin MCP 102, Admin turn 46, MCP Admin only 10) | 260 (app data 44, Admin turn 70, Admin MCP 126, new app home 6, MCP Admin only 14) |
| NOT_APPLICABLE | 134                                                                | 138                                                                                |
| a8Uncovered    | 0                                                                  | 0                                                                                  |
| a8Exempt       | 111                                                                | 105 (94 tools, 11 kinds, by name)                                                  |

The cells: 1016 of 139 tools, 3842 calls over both modes, 70 to 83 s
(process_extraction's edit gave the MCP Admin-only narrowing 12 to 14).

**Known failures now** (a8-known-failures.ts):

- P1, warn only, 22 cells (24 before): the read grant's member's edits
  through a turn and over MCP (formula, Recall map, card put and delete,
  task, note, event, page, table at the root; folder_describe at the root
  and in a folder). In warn both checks report and refuse nothing, so the
  edit is made; in on each is refused. P1 did not shrink to 16: in warn
  the edit check reports and refuses nothing, so these edits are still
  made; it shrank by the note_update folder cells, which left the pair pick
  when the positive cells moved it. app_snapshot_delete's read grant cells
  pass in both modes since the hotfix (the library asks edit).
- S11a-1, both modes, 4 cells: as before. The owner accepted it as a known
  limit, to revisit with S13 (2026-10-18).
- S11a-3, both modes, 2 cells (the Home Moderator's, in a folder; the Write
  grant's root cells are not failing in this pick): as before. sheet_build lands in the same
  Admin-only auto-filed folder; it declares no item (no cell), so it is
  recorded with S11a-3. The owner's answer (2026-10-18): a member exports
  what they see; feat/member-export changes the product, and S11a-3 is
  dropped on the rebase after it.
- S11a-5 (new, a bug), both modes, 2 cells: a member's move into a folder
  of another workspace answers "the database could not run this request":
  after the move, content tree/write.ts followShares calls
  mantle_embeds_reached, which reads node_embeds in the caller's scope, and
  the workspace role may not read that table (access-matrix.ts, admin pool
  only). page_move and tree_item_move over MCP.
- S11a-6 (new, the owner's question), both modes, 4 cells: a Write grant's
  member may not set a Files folder's indexing (folder_set_indexing) or
  rename a folder (tree_folder_update): the database answers "not allowed
  to edit this item", where the guide lets a Write grant edit.
- S11a-7 (new, a bug since 0302), both modes, 2 cells: app_table_export_set
  is refused for its app's Moderator. The export row's write check is
  `manage` (access-matrix.ts), whose INSERT branch asks a Moderator of the
  row's workspace_id (mantle_write_check_trg, written for grant rows), and
  app_table_exports has no such column: warn reports "INSERT on
  app_table_exports: not a Moderator of the workspace", on refuses it.
- S11a-8 (new, the owner's rule, 2026-10-18), both modes, 2 cells:
  process_extraction declares edit now (re-running an item's extraction is
  an edit of it); the tool still asks read, so the read grant's member's
  turn call answers ok. feat/member-export changes the policy; drop on
  rebase.
- S11a-2 and S11a-4 left the list (above).

**Gates** (on 9ff3206ca, main 7a7608fb1 under it; the handover commit
after it changes only this file). On the Mac: typecheck 0, lint 0, format
0, docs 0, arch 0, web build 0, unit (no database) 0. On the workstation,
own clone and own pg18 container (s11c_pg, port 55987, max_connections=450,
migrated with MANTLE_CHECK_FLOOR=keep), one at a time: full vitest with DB
0, test:actor-off 0, test:actor-on 0, test:edit-on 0, test:matrix 0 (98 s),
test:runtime-role (full config) 0. The same set was 0 on the head before
the last rebase (ab0ce298a under it). CI on the first push of this round
(4a0ae7b55) failed one cell, eslint-rules/no-bare-fetch.test.ts, a 15 s
timeout that main fixed in a4bc6a8c4 (in this base now).

**Open.** invoke_agent asks nothing of `subject_node_ids` itself (the child
reads them in the caller's scope): its refused cells now reach the invoker,
which the test does not register, so the item and a random uuid get the same
answer; nothing is shown about the item. generate_image's refused cells stop
at the missing image_gen worker before the reference images are read; a
worker fixture (fetch stays stubbed) would take them to the read.
process_extraction: settled by the owner (S11a-8).

## S11a: the rebase on v0.300.90 (2026-10-18)

**Done.** feat/s11a-tool-matrix rebased on main f970ff0cf (v0.300.90), no
conflicts: main brought the member export (files export-home.ts: a member's
app_export, sheet_build and export_node land where the member can see it;
process_extraction asks edit) and the S11a-7 hotfix (migration 0303: an
app table export is its app's managers' in every check mode). Three
findings left a8-known-failures.ts, and their cells pass as the rules their
tools declare:

- S11a-3 (2 cells): app_export by a member who reads the app is allowed
  (`read` of the app), and the file lands in the member's create home.
- S11a-7 (2 cells): app_table_export_set by its app's Moderator is allowed
  (`editDraft` of the app) in warn and on; the tool left `ALLOWED_KNOWN_ONLY`
  in a8-tool-cells.matrix.test.ts, so its allowed cell must pass.
- S11a-8 (2 cells): process_extraction by the read grant's member is
  refused (`edit` of the item, as its itemArgs ask now).

**Known failures left** (all as before, product code, not S11a's to fix):
P1 in warn (22 cells: a read grant's member's edit is made where only `on`
refuses it), S11a-1 (4 cells, an accepted limit: a hidden folder path shows
through file_create), S11a-5 (2 cells, a bug: followShares reads
node_embeds in a member's scope after a move), S11a-6 (4 cells, the
owner's question: a Write grant may not set a folder's indexing or rename
it), and the 8 P1 surface cells in off and warn.

**Pins.** None moved: arch:check reports nothing up or down. The tool
cells' counts are as in round 3 (1016 cells of 139 tools; narrowed 260, not
run 84).

**The matrix** (workstation, own pg18 container on port 56013,
max_connections=450, migrated with MANTLE_CHECK_FLOOR=keep; the test sets
the actor and the edit check together, as every box runs them; on
0885e3ebe): test:matrix exit 0, 4 files, 8 tests.

| Cells                | Check | Pass | Known failure                            | Unexpected |
| -------------------- | ----- | ---- | ---------------------------------------- | ---------- |
| tool cells (1016)    | warn  | 984  | 32 (P1 22, S11a-1 4, S11a-5 2, S11a-6 4) | 0          |
| tool cells (1016)    | on    | 1006 | 10 (S11a-1 4, S11a-5 2, S11a-6 4)        | 0          |
| surface cells (1155) | off   | 1147 | 8 (P1)                                   | 0          |
| surface cells (1155) | warn  | 1147 | 8 (P1)                                   | 0          |
| surface cells (1155) | on    | 1155 | 0                                        | 0          |
| SQL grid (9404 run)  |       | 9404 | 0                                        | 0          |

**Gates** (Mac, on 0885e3ebe): typecheck 0, lint 0, format 0, docs 0,
arch 0, web build 0, unit (no database) 0.
