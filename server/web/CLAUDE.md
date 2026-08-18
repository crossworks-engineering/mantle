# server/web: UI conventions

**Before any styling/UI work, read the style guide — it lives in the JACKDAW
repo now: `jackdaw/docs/ui-style-guide.md`** (GitHub:
`crossworks-engineering/jackdaw`). The frontend left this monorepo on
2026-08-13; the copy that used to sit at `docs/ui-style-guide.md` was a frozen
fork and was deleted 2026-08-18. Match `/tasks`, the reference screen, when
unsure.

⚠ Most of this file predates the split and describes screens that are no
longer here (only 5 `.tsx` files remain under `server/web`). Treat the
jackdaw guide as authoritative wherever the two disagree.

Non-negotiables (full detail in the guide):

- **Master-detail is the standard** for any list+editor screen (Notes, Traces, and all
  settings: Accounts/Agents/AI-workers/Heartbeats/Skills/Tools/Keys). Full-height
  `md:grid md:grid-cols-[340px_1fr]`; left = accent-card list, right = detail/form;
  Enabled/flags as header `Switch`es top-right + ghost Delete; auto-select first row.
  **Every scroll pane needs `min-h-0`** or `<main>` double-scrolls. See guide §8.

- **shadcn-first**: compose from `components/ui/*`; avoid raw `<button>`/`<input>`/`<select>`.
- **Theme tokens only**: `bg-background`, `text-foreground`, `text-muted-foreground`,
  `bg-card`, `border-border`, `bg-primary`, `bg-accent`, `bg-destructive`; status =
  `success`/`warning`/`info` (+`-ink` for text); `chart-1..5` = chart data ONLY (3:1,
  not legible as text, use the `-ink` roles or `code-*` instead).
  **Never hardcode colors**; opacity via `/NN`. Hardcoded colors break the ~40 themes.
  The theme CSS is GENERATED from `packages/share-ui/themes/seeds.mjs` (`pnpm themes:build`,
  docs/themes.md), never edit `themes.css` by hand.
  **Pair every fill with its OWN `-foreground`** (`bg-accent`+`text-accent-foreground`,
  `bg-primary`+`text-primary-foreground`, …), never mix pairs like `bg-accent text-foreground`
  (no contrast guarantee; breaks on light-accent themes). Same for hover/active fills. On a
  `bg-sidebar` surface use `hover:bg-foreground/[0.06]` (muted == sidebar in some themes). See
  style guide §2. Themed markdown: add `prose-accent` beside `prose` (§10).
- **No `window.prompt/confirm/alert`**: create/edit → `Dialog`; destructive confirm →
  `AlertDialog` (red action); feedback → `useToast()` (not inline error banners).
- **Bare icons inside `<Button>`**: no `mr-*`/`h-*/w-*` (base gives `gap-2` + `size-4`).
  `Button size="sm"` is `h-9`; match it with `ToggleGroup size="default"`.
- **Form submits use `<SubmitButton>`** (never bare `<Button type="submit">`): descriptive
  verb+noun label ("Save agent", "Create event"; not "Save"), no "Saving…" text-swap; pass
  `pending={…}` for client forms, nothing for server-action forms. See style guide §6.
- **Reuse shared patterns**: `<BackLink>` (detail back link), `<SetPageTitle>` (centered
  top-bar title; no duplicate on-page `<h1>`), `<TagInput>`/`<TagPill>` (tags as `string[]`,
  themed colors), `<MarkdownEditor>` (edit) / `ReactMarkdown`+`prose` (render),
  `<ShareControl nodeId>` (read-only public-link toggle on any shareable detail header;
  pass `beforeEnable` to publish first, pages pass `commit`). See [`docs/sharing.md`](../../docs/sharing.md).
- **List search/filter/pagination is URL-driven (SSR)**: server page reads `q`/`page`/filters,
  calls `list({…,limit,offset})` + `count*()`; client uses `useListNav()` (`go(patch)`) +
  `<ListPager>`. Don't client-filter a loaded list. Reference: `/pages` (mirrored by tasks/events/secrets).
- **Public surface (`/s/[token]`)** lives outside the `(app)` group, no app shell, and it
  must scroll itself (`h-dvh overflow-y-auto`) because globals.css pins `html/body` to
  `overflow:hidden` for the shell. Pages render via the server `renderPageDoc` (sanitized
  HTML), not the client editor.
- **Fonts**: FOUR user-selectable slots, ONE library. Settings → Appearance picks
  a face and a size for the **interface**, the **wordmark**, the **peer name**
  and **Pages/Notes prose**. Defaults: Inter, Bricolage Grotesque, and "same as
  interface" for the last two.
  - The single registry is `packages/client-types/src/display-fonts.ts`. It drives the
    `@font-face` block, the selection dialog, and the runtime CSS-var override.
    Every face in it is a VARIABLE font with **at least two axes**, and MUST
    carry its real `weight` range, or the browser treats the file as a single
    400 and synthesises bold across the whole app.
  - **Never hand-write a range.** `node scripts/fonts-import.mjs <file.ttf>`
    reads `fvar`/`name`/`OS/2` out of the binary, converts to woff2, installs
    into **both** apps' public dirs with the licence, and prints the row to
    paste. It refuses a face with fewer than two axes. `display-fonts.test.ts`
    asserts registry, files and licences agree in both directions, per app, and
    that the two apps' payloads are byte-identical. **woff2 only.**
  - Inter is the only always-loaded face (next/font) and deliberately carries no
    library file, so it is not shipped twice. The interface choice overrides
    `--font-sans` on `<html>`, which is why the next/font variable CLASS lives on
    `<html>` and not `<body>`: inline style only outranks a class on the SAME
    element. `--font-sans-base` always holds Inter so the modal's Inter row
    previews truthfully.
  - **Sizes are attributes, never resolved numbers.** `app.css` owns every
    multiplier: `html[data-font-size]` sets the ROOT font-size (so the rem-based
    shell scales whole), and `data-logo-size`/`data-title-size`/`data-prose-size`
    set local scale vars. Consume them through the `.wordmark`, `.peer-name` and
    `.prose-document` classes, which pair each face with its size.
  - `.prose-document` is for DOCUMENTS only — the Pages editor, the Notes
    reader, their share pages, and `/print` (which IS the PDF export). Chat, the
    changelog and help markdown are interface prose and stay on plain `.prose`.
  - The share/print shell (`server/pages/template.ts`) stamps the same
    attributes and vars as the client root layout. It has to: without them a
    PDF exports in the wrong face.
- **Tailwind v4**: no dynamically built class names (use literal-string arrays).
- **Editing CSS in `packages/web-ui/styles/` needs a dev-server RESTART.** HMR
  does not reliably pick up changes to the shared stylesheets, and the failure is
  silent: the app keeps serving the PREVIOUS build of `app.css`/`themes.css`, so
  a new rule simply does nothing while the source plainly contains it. Symptom is
  always "my CSS change had no effect". Confirm before you go debugging the
  feature, `curl` the `/_next/static/**.css` chunk and grep for your selector,
  or check `document.styleSheets` in the console. If it is absent there but
  present on disk, it is staleness: restart `pnpm dev` (clear `.next` if it
  persists), don't rewrite the rule.
- **Workflow**: `pnpm --filter @mantle/web run typecheck` before commit; commit on `main`
  with **no agent co-authorship trailers** (repo rule, see the root CLAUDE.md; a
  commit-msg hook strips them); don't push unless asked. The owner UI lives in the
  jackdaw repo since the 2026-08-13 split and runs detached against a deployed
  brain (db-less-dev.md there), so it browser-checks **client**
  changes, not this tier. `server/web` runs under `tsx` (`pnpm -C server/web dev`, no
  `next build`); its own render surfaces (`/s` shares, `/print`) need a running brain
  with a DB to view.
- **Detached dev is a `client/web` concern now**: `server/web` is the backend + render-surface
  tier, its `/s` and `/print` renderers run on the brain **with** the DB, so the old
  "gate DB reads behind `isDetachedDev()` or `pnpm dev:fe` 500s" rule no longer applies
  here. The zero-secret owner UI in `client/web` has no server-side DB path at all; it
  fetches every screen over HTTP via `apiFetch`/`apiSend`/`apiEventStream` (never raw
  same-origin `fetch` for data) against `MANTLE_SERVER_ORIGIN`.

**Team surfaces**: since the member carve, the `/team` + `/hub` + `/team-admin`
UI lives in `client/web` (this app keeps redirect stubs + the `/api/team*` data
plane and the `/s` share brokers; member credential model:
[`docs/team-chat.md`](../../docs/team-chat.md) topology note). The hub-app
authoring contract (thin `host.hub` SDK, sandbox rules, fallback chain) is
[`docs/team-hub-app-sdk.md`](../../docs/team-hub-app-sdk.md); the bridge
protocol (`@mantle/share-ui/app-bridge-protocol`) and the `@host` kit string
(`packages/app-build/src/kit.ts`) MUST stay mirrored (tripwire: `kit.test.ts`).

**Changing what a brain ships with** (default agents, skills, tool groups, workers,
the persona); there is ONE source of truth: the system manifest. Read
[`lib/system-manifest/CLAUDE.md`](lib/system-manifest/CLAUDE.md) first. Never
hardcode a model, prompt, grant, or worker in onboarding, a seed script, or the
runtime; change `lib/system-manifest/` and it propagates to fresh AND existing
brains.
