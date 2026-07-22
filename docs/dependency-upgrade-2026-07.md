# Dependency upgrade — 2026-07

Plan of record for bringing the dependency tree up to date. Branch:
`chore/dependency-upgrades`, forked from `main` at `f3249341` (v0.158.4).

Snapshot taken 2026-07-22 with `pnpm outdated -r`. Counts drift daily — re-run
before starting a wave; the *shape* of the plan is what matters, not the exact
patch numbers.

## The situation

**86 packages behind**: 22 major, 39 minor, 24 patch, 2 deprecated.

The important split is not major-vs-minor, it's **what needs a manifest edit**:

| | count | how |
| --- | ---: | --- |
| Already allowed by the declared `^` range | **67** | `pnpm update -r` — no `package.json` edit |
| Needs an explicit range bump | **19** | edit the manifest, one at a time |

Most of the drift is a **stale lockfile**, not stale manifests. 78% of it comes
back for the cost of one command and a verify run. The remaining 19 are the real
work.

### Baseline is green

Verified on this branch before any change:

```
pnpm verify   # typecheck (29 packages) + lint + format:check + vitest
→ 225 passed | 1 skipped (226 files) · 2565 tests passed | 38 skipped · exit 0
```

That is the gate for every wave below. CI (`build-check.yml`) runs the same four
steps plus `pnpm -C apps/web build`, so anything that passes locally passes CI.

## Rules of the road

1. **One wave per release.** `pnpm version:bump patch`, commit, `--no-ff` merge to
   `main` from the integrator. A wave that can't be described in one changelog
   line is too big.
2. **Never batch a major with anything else.** One major per commit, so a
   regression is a `git revert`, not an archaeology dig.
3. **`pnpm verify` + `pnpm -C apps/web build` green before every commit.** No
   exceptions, no "I'll fix the types after".
4. **UI-touching waves get a real look** — `pnpm dev:fe` against the workstation
   stack, not just a passing build.
5. **Anything that touches Postgres gets a backup first** and rolls to one box
   before the fleet.
6. **Re-run `pnpm licenses:notices`** at the end of each wave — the notices file
   is already ~6 weeks stale and has no CI guard (see the follow-up task).

## Wave 1 — in-range refresh (67 packages, no manifest edits)

The cheap 78%. `pnpm update -r` moves everything to the top of its existing
range. Split into three commits so a regression is bisectable:

**1a — backend, tooling, types.** Everything except the editor and UI kit.
Notable movers: `@dbos-inc/dbos-sdk` 4.22→4.24 (durable runner), `@openrouter/sdk`
0.12.35→0.12.79 (44 releases of a 0.x — read its changelog), `imapflow` 1.3→1.4 and
`mailparser` 3.9.8→3.9.14 (email ingest), `grammy` 1.42→1.45 (telegram),
`undici` 8.3→8.8, `next` 15.5.18→15.5.21, `prettier` 3.8→3.9 (may reformat — run
`pnpm format` and commit the churn separately).

**1b — TipTap 3.23 → 3.28.** Sixteen `@tiptap/*` packages that must move together
or the editor breaks on mismatched peer versions. Gate: open a Page, exercise
tables, math, mentions, task lists, drag handles, code blocks.

**1c — Radix + UI.** `radix-ui` umbrella 1.4→1.6 plus ~15 individual
`@radix-ui/react-*`. Several are minors (avatar 1.1→1.2, slider 1.3→1.4, switch
1.2→1.3, select 2.2→2.3, slot 1.2→1.3). Gate: the master-detail settings screens,
dialogs, and every `Switch`/`Select` surface.

> **Checked, and it's fine:** the tree declares *both* the `radix-ui` umbrella
> package and ~15 individual `@radix-ui/react-*` packages, and both import styles
> are in real use (5 files from the umbrella, ~19 from individual packages). That
> looks like it should produce two physical copies of each primitive and hence
> two React contexts — but the lockfile resolves **exactly one version per
> primitive**, so there is no skew and no double-context bug. (Duplicate
> `@radix-ui+*` directories under `node_modules/.pnpm` are stale leftovers from
> earlier installs, not live resolutions — don't be fooled by them, as I was.)
> Collapsing to one import style is tidiness, not a correctness fix.

### Wave 1 status: ✅ done (2026-07-22)

`86 → 27 outdated.` 59 packages moved, no major crossed, nothing added or
removed. Commits: `5bdfd251` (1a) · `0bbb83e1` (prettier churn) · `16313bd7`
(1b) · `fe90c621` (1c).

Gates at the end of the wave: `pnpm verify` green (2565 tests) **and** a full
`pnpm -C apps/web build` green.

Two things worth carrying forward:

- **`pnpm update` rewrites the declared ranges, not just the lockfile.** The
  caret baselines moved too (`react ^19.0.0` → `^19.2.7`). Harmless and arguably
  good hygiene, but it means "in-range refresh" still produces a manifest diff —
  check it for net-new/removed deps rather than assuming it's lockfile-only.
- **`@types/heic-convert` 2.1.0→2.1.1 paid for itself.** It corrected
  `ConversionOptions.buffer` from `ArrayBufferLike` to `Uint8Array`, which let us
  delete a `as unknown as ArrayBufferLike` cast in `packages/files/src/transcode.ts`.
  Typecheck caught it; the fix was to remove the workaround, not re-fudge it.

Still outstanding (27), all needing an explicit range bump: the 19 originally
identified, plus 8 that took their in-range bump but still have a major waiting
(`eslint` 9.39.5→10, `next` 15.5.20→16, `@types/node` 22.20.1→26,
`@openrouter/sdk` 0.12.79→1.0, `concurrently`, `eslint-config-next`,
`@eslint/js`, `@types/nodemailer`).

## Wave 2 — isolated majors (small blast radius, one commit each)

Each of these touches 0–3 files. Cheap, independent, high confidence.

| package | jump | files | what to prove |
| --- | --- | ---: | --- |
| `bcryptjs` + `@types/bcryptjs` | 2 → 3 | 3 | **Existing password hashes still verify.** Log in as an existing user before *and* after. v3 ships its own types → delete `@types/bcryptjs` (it's flagged deprecated). |
| `chokidar` | 4 → 5 | 2 | Docs-collection watcher still picks up file changes. |
| `react-day-picker` | 9 → 10 | 2 | The shared `DateTimePicker` — events, todos, secrets. |
| `katex` | 0.16 → 0.18 | — | Math rendering in Pages. |
| `@openrouter/sdk` | 0.12 → 1.0 | 2 | Chat + embeddings still route. Pairs with 1a. |
| `nodemailer` + `@types/nodemailer` | 6 → 9 | 1 | **Send a real email.** Three majors on the outbound path. Check whether v9 ships its own types and drop `@types/nodemailer` if so. |
| `pdf-parse` 1→2, `pdfjs-dist` 5→6 | | 2 | PDF ingest + the password-protected path. `pdf-password.ts` dynamically imports `pdfjs-dist/legacy/build/pdf.mjs` — **that subpath may have moved in v6**; verify before assuming. |
| `esbuild` | 0.24 → 0.28 | 2 | Mini-app bundling (`packages/app-build`). Has an `allowBuilds` entry in `pnpm-workspace.yaml`. Build + publish an app, load it in the sandbox. |
| `@napi-rs/canvas` | 0.1 → 1.0 | 0 direct | Pinned `~0.1.100` deliberately. `next.config.ts` externalizes it *by name* (including per-platform `@napi-rs/canvas-<os>-<arch>`) for the webpack production build — **read that block before bumping**, and prove `pnpm -C apps/web build` still works, not just dev. |
| `@types/libsodium-wrappers` | deprecated | — | No newer version exists. Check whether `libsodium-wrappers` now ships its own types; if so delete, else leave and document why. |

### Wave 2 status: ✅ done, with two caveats (2026-07-22)

Nine of ten items landed. One was deliberately **not** taken.

| item | outcome |
| --- | --- |
| `@types/libsodium-wrappers` | removed — upstream ships real types |
| `katex` 0.16→0.18 | ✅ |
| `chokidar` 4→5 | ✅ proved at runtime |
| `react-day-picker` 9→10 | ✅ `table` classNames key → `month_grid` |
| `bcryptjs` 2→3 (+drop `@types/`) | ✅ v2 hashes proved to verify under v3 |
| `@openrouter/sdk` 0.12→1.0 | ✅ `/models/errors` subpath survived |
| `nodemailer` 6→9 (+types 6→8) | ✅ message building proved; real send still manual |
| `pdf-parse` 1→2 | ❌ **held at 1.x** — see below |
| `pdfjs-dist` 5→6 | ✅ + single-version pin |
| `esbuild` 0.24→0.28 | ✅ |
| `@napi-rs/canvas` 0.1→1.0 | ✅ (was a required repair, not a bump) |

**The big lesson: wave 1 shipped two latent breakages that its gates could
not see.** Both were in-range bumps whose transitive native deps moved:

- `pdf-to-png-converter` 4.0.0→4.1.1 pulled a second `pdfjs-dist` (6.0.227
  alongside 5.7.284). pdfjs compares API and Worker version strings *exactly*
  and its worker config is process-global, so two copies in one process break
  whichever loads second.
- The same bump moved its `@napi-rs/canvas` to 1.0.2 while `apps/web` stayed
  pinned at `~0.1.100`. That pin exists so next.config.ts's webpack
  externalization *resolves* at runtime — so the mismatch would have handed a
  0.1.x native binding to a library built for 1.0.x.

Neither `pnpm verify` nor `next build` executes a PDF, so both passed clean.
**Add a runtime smoke check to the gate for anything with a native binding
or a process-global singleton** — types and a successful build are not
evidence there.

~~`pdf-parse` 2 is held back~~ **— superseded, see below.** It was held back on
the assumption that forcing it onto our pdfjs would degrade extraction. That
assumption was tested afterwards and was wrong; pdf-parse 2 was adopted in
`8201a03e`. See "pdf-parse 2, revisited".

Also worth carrying forward: **pnpm 11 reads `overrides` from
`pnpm-workspace.yaml`, not `package.json`.** A `pnpm.overrides` block in
package.json is silently ignored — `pnpm install` just reports "Already up to
date" and changes nothing.

## Wave 3 — wide but mechanical

**`lucide-react` 0.469 → 1.25** — 201 files. It's an icon library going 0.x→1.0;
the risk is renamed or removed icon names, and **typecheck catches every single
one**. Big diff, low danger. Do it alone, let `tsc` drive the rename list.

**`recharts` 2 → 3** — 11 files. Real API changes between majors. Charts live in
the dashboard and `/debug/spend`; check each rendered chart visually.

### Wave 3 status: ✅ done (2026-07-22)

Both items landed. `16 → 14 outdated.`

**`lucide-react` 0.469 → 1.25 needed zero code changes** across all 201 import
sites — not one icon we use was renamed or removed. That clean pass was checked
to be *meaningful* rather than vacuous: a canary importing a non-existent icon
fails with TS2305, so lucide's types are strict and typecheck really is proof
here. Bundle unchanged at 103 kB.

**`recharts` 2 → 3 needed five fixes**, all in the typing of custom tooltip and
legend content, all resolved using recharts' own exported types rather than
hand-rolled shapes:

| change | fix |
| --- | --- |
| `payload`/`label`/`active` off public Tooltip props (context-injected) | use exported `TooltipContentProps`, as `Partial<>` |
| `LegendProps` Omits `payload`, keeps `verticalAlign` | split the `Pick<>`; declare `payload?: LegendPayload[]` |
| `dataKey` widened to allow a function | no longer valid as a React key — reuse the stringified local |
| `<Bar layout>` removed | parent `<BarChart layout>` already drove it; prop was redundant |
| `labelFormatter` first arg now `ReactNode` | narrow with `String()` before parsing |

> **Open verification gap.** There is no jsdom or testing-library in this repo —
> `vitest.config.ts` says outright that "UI behaviour goes through `pnpm build`
> + manual smoke". So verify + build being green says nothing about whether
> charts actually *render*. Before merge, eyeball the dashboard
> (`ingest-chart`, `spend-chart`, `brain-breakdown`) and `/debug/spend`.
> Adding a render-test setup is worth considering, but not mid-upgrade.

### pdf-parse 2, revisited — adopted after testing (2026-07-22)

Wave 2 held pdf-parse at 1.x on the *assumption* that forcing it onto pdfjs
6.1.200 (a full major above its pinned 5.4.296) would risk silently degraded
extraction. That was caution, not evidence. Tested afterwards; the assumption
was wrong.

**It works.** Two pins were needed rather than one — pdf-parse 2 also drags in
its own `@napi-rs/canvas` (0.1.80) beside our 1.0.2. With both pinned in
`pnpm-workspace.yaml`, the tree holds exactly one pdfjs and one canvas, and
every path passes: `parsePdf` → `extractPdfTextWithPassword` (the order that
previously failed), and rasterize either side of it.

**Extraction output changes, for the better:**

| | pdf-parse 1.x | pdf-parse 2 |
| --- | ---: | ---: |
| output | 11,045 chars | 2,038 chars |
| tokens in v1 missing from v2 | — | **none** |
| formatting | fixed-width, space-padded | clean |
| page markers | none | `-- N of M --` |

81% of v1's output was whitespace padding that every PDF chunk carried into its
embedding. Decision: adopt, and **do not re-extract** existing PDFs — old ones
keep padded text, new ones get clean text, both retrieve fine.

> Correction to an earlier note in this doc: page markers are a **v1→v2**
> difference, not a pdf-parse-vs-pdfjs one. v1 emits none; v2 adds them. Raw
> pdfjs (the consolidation route) emits clean text with no markers.

**It also appeared to expose a drizzle instance split — it did not.** Worth
recording because the false trail cost real time, twice.

Removing the obsolete `@types/pdf-parse` stub produced 96 errors in
`packages/files/src/ops.ts`: `SQL<unknown> | undefined` "not assignable" to a
superset of itself, which genuinely is the signature of two copies of drizzle's
types. Reading the symlink in `node_modules/.pnpm` showed `packages/files` on a
bare `drizzle-orm` instance and `@mantle/db` on a peer-resolved one, so I
declared `postgres` to align them and filed a high-priority task claiming 12
packages were on the wrong instance.

**All of that was wrong.** Measured properly — `rm -rf node_modules` then
`pnpm install --frozen-lockfile`, i.e. what CI actually does:

```
21 packages → drizzle-orm@0.38.4_@types+react…postgres@3.4.9_react@19.2.7
 1 instance on disk
```

Every workspace package already shares one instance; pnpm's peer dedupe handles
it. The `postgres` dep was a phantom and is reverted (`3c120b40`). **Wave 4's
drizzle upgrade has no such blocker.**

> ### The lesson that actually generalises
> **`node_modules/.pnpm` accumulates stale `<pkg>@<ver>_<peers>` directories
> across incremental installs.** They are indistinguishable by eye from live
> duplicate resolutions, and a workspace package can be left symlinked to a dead
> one — producing type errors that look completely real and reproducible, and
> that vanish on a clean install.
>
> This caught me **twice** in this effort: first as "duplicate Radix copies" in
> wave 1, then here. Both walked back.
>
> 1. Verify duplicate-version claims against **`pnpm-lock.yaml`**, never
>    `ls node_modules/.pnpm`.
> 2. Reproduce any resolution diagnosis after
>    `rm -rf node_modules && pnpm install --frozen-lockfile` before believing it.
> 3. Don't infer a workspace-wide property from two packages — enumerate.
>
> The `pdfjs-dist` and `@napi-rs/canvas` overrides are the real thing by
> contrast: verified against the lockfile, and still one copy each after a clean
> install.

## Wave 4 — deep, one release each

**`eslint` 9 → 10** (+ `@eslint/js`, `typescript-eslint`, `eslint-config-next`).
Lint-only, zero runtime risk — do it first in this wave to get a win. Flat config
is already in use. `eslint-config-next` is coupled to the Next major, so either
hold it at 15.x here or fold it into Wave 5.

**`vitest` 2 → 4** — two majors across 226 test files. Config and mocking APIs
move between majors. Risk is *test-only*, but a broken suite blinds every later
wave, so it must land clean.

**`zod` 3 → 4** — 141 files. Almost all of it is `z.object({...}).parse(body)` in
`apps/web/app/api/**` route handlers: mechanical, and typecheck-guided. The one
genuinely risky site is **`packages/mcp-core/src/build-server.ts`**, where zod
shapes become JSON Schema for MCP tool definitions — a silent shape change there
degrades every tool the assistant sees. Diff the generated tool schemas before
and after and compare them explicitly. Zod 4 ships a `zod/v3` compat entrypoint,
so a staged migration is possible if the big-bang diff gets ugly.

**`drizzle-orm` 0.38 → 0.45** (+ `drizzle-kit` 0.30 → 0.31) — 238 files, the
widest surface in the repo. Mitigating factor: **migrations here are hand-written
SQL run by our own per-migration-transaction runner**, not drizzle-kit generated —
so this is a query-API upgrade, not a migration-tooling upgrade. Still 0.x, where
minors are breaking by convention. Gate on the full suite plus a real
`/debug/integrity` corpus audit.

## Wave 5 — framework

**`next` 15 → 16** (+ `eslint-config-next` 16). React 19.2 is already in place, so
the peer requirement is satisfied. Surfaces to check: `next.config.ts` (it carries
a hand-written webpack externals block for `@napi-rs/canvas`), route handlers,
middleware, the `(app)` route group, and the public `/s/[token]` surface outside
it. Detached mode (`pnpm dev:fe`) must still work — that's a documented
constraint in `apps/web/CLAUDE.md`.

Do this **after** Wave 4 so zod/drizzle churn isn't tangled with framework churn.

## Wave 6 — pg-boss 10 → 12 (highest risk, own release, staged rollout)

Two majors on the job queue. This is the only item on the list that can lose data.

- **30+ touchpoints** across `apps/api`, `apps/web/workers`, `packages/runs`,
  `packages/email`, `packages/telegram`, `packages/microsoft`.
- **It owns and migrates its own `pgboss` schema on boot.** Once a box starts on
  v12 the schema is migrated; rolling back the image does *not* roll back the
  schema.
- In-flight jobs at upgrade time are the failure mode to think hardest about.

Required sequence:

1. Read the v11 and v12 migration notes end to end. Budget real time for this.
2. `pnpm db:dump` — verified backup, restore-tested, before anything.
3. Drain the queues (stop workers, let in-flight jobs finish) before the roll.
4. Upgrade the **dev brain only**. Run it for several days under real load —
   email sync, telegram, runs, heartbeats, maintenance sweeps.
5. Then one production box. Then the rest of the fleet.

Do not bundle this with any other change.

## Deferred — TypeScript 5.9 → 7.0

**Recommendation: do not attempt in this effort.** TypeScript 7 is the native
port — a different compiler implementation, not an incremental release. It lands
across all 29 workspace packages at once, and `typescript-eslint` 8.65 is very
unlikely to support it yet, which would take the entire lint gate offline exactly
when we need it most.

Revisit as its own project once: `typescript-eslint` ships explicit TS 7 support,
Next 16 supports it, and Waves 1–6 are merged. Until then hold at the latest 5.x.

## Sequencing summary

```
Wave 1  in-range refresh (67 pkgs, 3 commits)     ← start here, biggest win/effort ratio
Wave 2  isolated majors (10 items, 1 commit each)
Wave 3  lucide-react, recharts
Wave 4  eslint → vitest → zod → drizzle
Wave 5  next 16
Wave 6  pg-boss (backup + staged fleet rollout)
────────
defer   typescript 7
```

Waves 1–3 are low-risk and can move quickly. Wave 4 onward wants one release each
and time on the dev brain between them.

## Keeping it from rotting again

The reason we're 86 behind is that nothing watches. Before closing this out:

- Re-run `pnpm licenses:notices` and commit (last generated 2026-06-10).
- Add a CI drift check that regenerates the notices and fails on a diff.
- Add a scheduled `pnpm outdated -r` report so drift is visible monthly instead
  of discovered annually.
