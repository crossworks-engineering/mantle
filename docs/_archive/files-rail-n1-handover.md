# Files rail N+1: handover

Branch `feat/files-rail-n1`, forked from main 520659a30 (v0.300.118). Not
merged, tagged or rolled.

## The defect

`listAllFolders` (the owner's Files tree rail, and the `folder_list` tool
with `tree: true`) awaited `folderCounts` once per folder, and
`folderCounts` runs two queries (an lquery `path ~ 'x.*{1}'` for the
subfolders, `path::text = x` for the files). An owner reads every folder,
so a brain with about 2,000 folders sent about 4,400 statements. The plan
v3 S13 handover measured 17 s; `listFolders` (one folder's list) had the
same loop over its children.

## The change

`packages/files/src/ops/folders.ts`, through the same scoped `db` handle
and the same predicates, so each reader's row rules apply as before:

- `readRail` (behind `listAllFolders` and `listAllFoldersWithTrail`): the
  folders under `files` (unchanged statement), and one grouped query for
  the files the reader reads under `files`, by path. A folder's
  subfolders all sit under `files` too, so its `childFolderCount` is
  counted from the folder rows already read. Two statements in all.
- `listAllFoldersWithTrail` takes its files list from `readRail` (the rows
  below the root), so the trail no longer reads the files a second time.
- `listFolders` uses `countsBelow`: one grouped query for the folders two
  levels below the parent (by their parent's path) and one for the files
  one level below it (by path). Three statements in all, for any parent,
  `*` and `files.*` included.

`folderCounts` stays for the single-folder reads (a folder by id or path,
create, rename, delete).

## Answers

Byte equal to the per-folder path: same rows, counts and order, for the
owner (unscoped and in its own scope) and for a member that reads part of
the tree (a granted folder holding another login's private file, a granted
file under folders it does not read, folders it does not read at all, root
files nobody granted). Cell file:
`packages/files/src/folder-counts-grouped.db.test.ts` (5 cells: the
fixture, `listAllFolders` and `listFolders` against the old loop kept
verbatim in the test, the member's rail with the trail definer, and the
statement count: two for the rail and three for a list, the same after 40
more folders, while the old loop sends 80 more).

## Perf

A scratch brain on the workstation: 202,221 nodes, 2,221 folders under
`files` (20 top, 10 mid each, 10 leaf each), 100 files in each leaf
(200,000 files); a member granted `files.t1` whole (111 folders, 10,000
files) and one file in 18 other tops. Medians (old 3 to 5 runs, new 15):

| read                          | old       | new      |
| ----------------------------- | --------- | -------- |
| owner rail, unscoped          | 49,014 ms | 49.8 ms  |
| owner rail, owner scope       | 95,560 ms | 195.5 ms |
| member rail (listAllFolders)  | 4,250 ms  | 41.2 ms  |
| member rail with the trail    | not run   | 70.0 ms  |
| owner list `files` (20)       | 497 ms    | 38.3 ms  |
| owner list `files.t1` (10)    | 245 ms    | 4.2 ms   |
| owner list `files.t1.m1` (10) | 241 ms    | 2.6 ms   |
| member list `files.t1` (10)   | 390 ms    | 47.4 ms  |

The old times are higher than the S13 handover's 17 s (a busier box, a
larger tree); the ratio is the point.

## Counters

`pnpm arch:check` 0; the scoreboard output is identical on main and the
branch, so no pin moved.
