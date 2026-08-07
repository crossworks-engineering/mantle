# Draw workspace: audit handover

> STATUS: experimental, on `feat/draw-workspace` only. This document exists so
> an auditor (a fresh session, or Jason) can verify the integration is done
> well WITHOUT trusting the sessions that built it. Claims below are split
> into what is machine-checkable, what was verified by hand (with the
> evidence), and what is honestly NOT verified yet. The design rationale
> lives in [draw-plan.md](./draw-plan.md); this document is about checking
> the implementation against it.

## 1. Scope of the change

Seven commits on top of `v0.225.2` (`0b1553ae`):

| Commit | Phase | Content |
|---|---|---|
| `3ade79ea` | plan | docs/draw-plan.md |
| `b853a8b8` | 0 | dep (exact pin), self-hosted fonts, canvas wrapper |
| `b8eb8014` | 1 | migrations 0144/0145, `draws` sidecar, content CRUD, scene-to-text, API routes |
| `557d86c8` | 2 | /draw list + /draw/[id] editor, autosave/commit, nav, help |
| `69daf49c` | 3 | extractor + search enums + embedded-asset fold |
| `8bd2834f` | 4 | sharing (/s, team reader), export (svg/pdf), print surface |
| `6847afdb` | 5 | draw_list/draw_get builtins, `draw-read` group, MCP bridge |

52 files, +4120/-25 against the merge base. The deletions are the three
search-enum context lines and the scaffold page replaced in Phase 2; nothing
else that existed before this branch was removed or behaviourally changed.
`git diff 0b1553ae..HEAD --stat` is the ground truth.

**Main has advanced since the branch was cut** (v0.225.3, the detached-client
export-download fix). Three files are touched by both sides and are the whole
expected rebase surface: `client/web/components/export/export-menu.tsx`,
`client/web/package.json`, `server/web/app/api/export/[id]/route.ts`. After
rebasing, re-verify that draw SVG/PDF downloads work from the detached client
(they should inherit the fix; that combination has never been run).

## 2. The core claim to audit: "purely additive"

The go/no-go rule from the plan: any change to existing behaviour outside
`package.json` kills the merge. What "additive" means concretely here:

- Every touched pre-existing file gained an enum value, a nav row, an icon
  map entry, a union variant, a switch case, a new route mount, or a new
  import. No existing branch of logic changed.
- Two deliberate exceptions an auditor should look at and accept or reject:
  1. `SCENE_SVG_MAX_BYTES` lives in a NEW file, but the commit route's zod
     schema uses it as a string-length cap. zod `.max()` counts characters,
     `acceptSceneSvg` counts bytes; a multibyte payload between the two
     limits passes zod and is dropped by the byte check. Outcome is
     stored-null, never an error. Intentional.
  2. `evaluateDraftRev` and `foldEmbeddedText` are imported from `pages.ts`
     into `draws.ts` rather than copied. This couples draws to pages'
     internals by design ("one truth"); a future pages refactor now has a
     second consumer.

Verification: `git diff 0b1553ae..HEAD -- <file>` on every file that existed
before the branch, and confirm each hunk is one of the shapes above.

## 3. Invariants, and how to check each one

| # | Invariant | Check |
|---|---|---|
| I1 | Drafts never cross a trust boundary: list/preview/share/export/MCP/extractor all read committed state only | grep the read paths: `loadShareView` reads `getDrawSvg` (commit-time), `resolveExport` same, extractor reads `scene_text` (written only by `commitDraw`), `draw_get` reads `scene_text` and flags `has_uncommitted_draft` |
| I2 | The scene blob never carries bytes | `uploadNewSceneFiles` uploads before the scene references anything; `normalizeScene` stores only `elements` + a whitelisted `appState`; there is no code path writing `files`/dataURLs into `draws.scene` |
| I3 | Nothing scriptable is ever stored in `scene_svg` | `acceptSceneSvg` is REJECT-not-rewrite; unit-tested (script/foreignObject/handlers/js-urls/data-html/oversize). The /s page injects it inline, so this function is the entire safety argument. Audit it hard (see G5) |
| I4 | One extraction per commit, none per stroke | autosave writes `draft_scene` only and never fires `node_ingested`; `commitDraw` is the only notify site; the extractor skip-trace on thin bodies was observed live |
| I5 | Owner isolation | every content function filters `ownerId` + `type='draw'`; smoke-tested (foreign owner reads null) |
| I6 | Optimistic concurrency is pages-equivalent | same `evaluateDraftRev` + row lock; stale `if_rev` returns 409 and mutates nothing; conflict pauses client autosave until remount |
| I7 | Editor chunk stays draw-only | production build: the excalidraw chunk chain resolves only into `draw/[id]`'s react-loadable manifest; list route renders SVG, never the canvas |
| I8 | No CDN egress, ever | fonts synced to `public/excalidraw-assets` by a pre(dev\|build) script; `EXCALIDRAW_ASSET_PATH` set at module scope in the one wrapper; verified in the network log (Excalifont served locally, zero external requests) |
| I9 | Stale previews cannot exist | a commit without a valid SVG CLEARS the stored one (observed live: server-side commit nulled it, next UI commit restored it) |
| I10 | Kill path stays cheap | branch delete + `DROP TABLE draws`; the enum value stays (harmless); no other table references draws |

## 4. Verification record (what was actually run)

- **Migrations**: all 146 replayed on a THROWAWAY database (fresh + init
  scripts), then 0144/0145 applied to the dev DB. Enum-in-own-file rule
  respected (mirrors 0136).
- **CRUD/etag lifecycle**: an 18-step ad-hoc smoke against the throwaway DB
  (create, draft, stale-rev conflict, commit, svg accept + hostile-svg drop,
  discard, search-by-body, owner isolation, cascade delete). ⚠ This script
  was NOT committed; see G1.
- **Unit tests committed**: `scene-to-text.test.ts` (12), `scene-svg.test.ts`
  (6). Content suite 870/870, tools+manifest 411/411, help contract green.
- **Editor loop, in a real browser** against a worktree server pair on the
  dev DB: create → draw → autosave PUT 200 → hard reload resumes the draft
  exactly → commit 200 (version bump, draft cleared, scene_text derived,
  16.4 KB exportToSvg snapshot stored) → list preview renders it.
- **Brain loop, live**: a committed sketch (frame, labelled shapes, three
  bound arrows, a canary term) produced a faithful summary, embedding, one
  chunk, three relation edges, two facts; the palette returned it as TOP hit
  for the canary in both Results and Passages modes; the extractor's
  20-char minimum skipped a thin scene with a typed skip trace.
- **Share gate**: the public /s page for the drawing returned HTTP 200 with
  exactly one inline `<svg>` and ZERO `<script>` tags (curl audit), and
  renders correctly in a browser.
- **Export gate**: `?format=svg` returned the stored bytes verbatim
  (16,360 bytes, `image/svg+xml`); `?format=pdf` returned `%PDF-1.4` (31 KB)
  through the real browserless sidecar via the new `/print/draws/:id`.
- **Agent tools**: handlers invoked directly against the dev brain
  (list-by-query hit, full content read, corrective not-found error).

## 5. Honest gaps: NOT verified, divergences, and audit questions

Ordered by how much they matter.

- **G1, no committed integration tests for the draws CRUD.** The 18-step
  lifecycle smoke ran once, by hand, and was deleted. The etag/lock logic is
  shared with pages, but the draws wrapper code (normalize, fold, svg
  handling, fileRefs) has zero automated coverage. Recommendation: port that
  smoke into the e2e suite (the repo has one) or a DB-backed vitest before
  merge. This is the biggest process gap.
- **G2, kill criterion 3 unexercised.** No upstream package upgrade has been
  run against stored scenes. The plan requires a pin-bump corpus test
  (load every stored scene through `restore()`, confirm no corruption)
  before any merge. Not started.
- **G3, image paste never browser-exercised.** `scene-files.ts` (upload new
  BinaryFiles → file nodes, rehydrate on load, OCR fold on commit)
  typechecks and mirrors the page-editor upload exactly, but no human or
  browser run has pasted an image into a canvas yet. The fold helper's DB
  query is also untested beyond typecheck.
- **G4, image files are never garbage-collected.** Deleting a drawing keeps
  its uploaded images in /files (documented as behaviour in the help doc,
  and pages behave the same), but images uploaded into a draft that is then
  REVERTED are orphaned silently: the file node exists, nothing references
  it. Pages have an orphan self-heal for their embeds; draws are not wired
  into it. Decide: acceptable parity gap or pre-merge fix.
- **G5, the SVG safety argument is one regex function.** `acceptSceneSvg` is
  a blocklist (script, foreignObject, iframe/embed/object, `on*=`
  handlers, `javascript:`, `data:text/html`, oversize). The /s template
  sets no Content-Security-Policy (checked; this predates the branch and
  applies to page shares too), so there is no second layer. An auditor
  should try to construct an SVG that passes the checks and still executes
  (e.g. exotic attribute encodings, `xlink:href` payloads, animation-based
  vectors, nested `<use>`). The REJECT posture means any new bad pattern is
  one regex away from fixed, but the list is only as good as its authors.
- **G6, dirty-flag divergence from pages.** Dirtiness is
  `hashElementsVersion` inequality vs the committed hash. Element versions
  only grow, so undoing back to the exact committed state still shows
  "Draft · uncommitted" (pages' JSON compare would clear it). Cosmetic,
  costs one no-op commit at worst.
- **G7, pan/zoom alone is never autosaved.** The change hash covers elements
  only; a pure viewport move saves nothing (deliberate, avoids PUT-on-
  scroll), so the saved scroll position is whatever rode along with the
  last content save. Resume can be slightly stale.
- **G8, `beforeEnable={commit}` no-ops when clean.** Sharing a never-
  committed drawing mints a link to the "Nothing committed here yet"
  placeholder. Correct per design, but confirm the UX is acceptable.
- **G9, theme-flip and mobile were not visually exercised.** The canvas
  theme prop wiring is one line off next-themes and the share/preview mats
  are deliberately light, but nobody has LOOKED at dark/light toggling or a
  narrow viewport on these screens.
- **G10, `pnpm verify` has not been run on the workstation.** House rule for
  merges. Mac runs covered targeted suites only.
- **G11, request-size ceiling for scene PUTs is unaudited.** A very large
  scene (thousands of elements) rides one JSON body through draft saves;
  whatever body limit the server framework applies is the only cap. Check
  the hono/body limit and decide whether draws need their own.
- **G12, one live-DB write from a feature branch.** Migrations 0144/0145 are
  applied to the shared dev DB and test content exists there (one drawing,
  its derived facts/edges, one throwaway login). Inventory in §7.

## 6. Suggested audit procedure

1. Read [draw-plan.md](./draw-plan.md) §2 (constraints) and §8 (kill
   criteria), then diff the implementation against them, not against this
   document.
2. `git log --oneline 0b1553ae..HEAD` and walk each commit's diff for the
   additive-only claim (§2), especially every hunk in a pre-existing file.
3. Re-run the machine checks: content + tools + manifest + help suites,
   typecheck in the six touched packages, a production client build, and
   the chunk-isolation check (I7).
4. Attack `acceptSceneSvg` (G5) with hostile SVGs; add every miss to the
   unit test as you go.
5. Replay migrations on a fresh throwaway DB (the migrate runner replays
   0001→latest; needs the compose init scripts for `auth`).
6. Re-run the browser loop of §4 on a worktree pair, INCLUDING the two
   unexercised paths: paste an image (G3) and flip the theme (G9).
7. Run the pin-bump corpus test (G2), then decide the merge.

## 7. Cleanup inventory (when the experiment concludes, either way)

- Dev DB: one test drawing ("Ingest architecture sketch") whose delete
  cascades its sidecar row, chunks, facts and edges via the existing
  reapers; one throwaway login (`draw-test@example.com`) in `auth.users`.
- If abandoned: delete the branch, `DROP TABLE draws;` on any DB that ran
  0145 (dev only, today). The enum value remains and is harmless.
- If merged: none of the above blocks anything; the test content is
  ordinary deletable content.

## 8. Pre-merge checklist (the short version)

- [ ] Rebase onto main; resolve the three known-overlap files; re-verify
      draw downloads from the detached client (they should inherit v0.225.3's fix)
- [ ] G1: commit an automated lifecycle test
- [ ] G2: upstream pin-bump corpus test
- [ ] G3: image-paste browser run
- [ ] G5: hostile-SVG session against acceptSceneSvg
- [ ] G10: `pnpm verify` on the workstation
- [ ] Decide G4 (orphaned draft images) and G8 (share-before-commit UX)
- [ ] Merge via `scripts/merge-branch.sh` (version bump happens on main)
