# apps/web — UI conventions

**Before any styling/UI work, read [`docs/ui-style-guide.md`](../../docs/ui-style-guide.md).**
It's the rulebook; match existing screens (Notes + the settings screens) when unsure.

Non-negotiables (full detail in the guide):

- **Master-detail is the standard** for any list+editor screen (Notes, Traces, and all
  settings: Accounts/Agents/AI-workers/Heartbeats/Skills/Tools/Keys). Full-height
  `md:grid md:grid-cols-[340px_1fr]`; left = accent-card list, right = detail/form;
  Enabled/flags as header `Switch`es top-right + ghost Delete; auto-select first row.
  **Every scroll pane needs `min-h-0`** or `<main>` double-scrolls. See guide §8.

- **shadcn-first** — compose from `components/ui/*`; avoid raw `<button>`/`<input>`/`<select>`.
- **Theme tokens only** — `bg-background`, `text-foreground`, `text-muted-foreground`,
  `bg-card`, `border-border`, `bg-primary`, `bg-accent`, `bg-destructive`, `chart-1..5`.
  **Never hardcode colors**; opacity via `/NN`. Hardcoded colors break the ~40 themes.
  **Pair every fill with its OWN `-foreground`** (`bg-accent`+`text-accent-foreground`,
  `bg-primary`+`text-primary-foreground`, …) — never mix pairs like `bg-accent text-foreground`
  (no contrast guarantee; breaks on light-accent themes). Same for hover/active fills. On a
  `bg-sidebar` surface use `hover:bg-foreground/[0.06]` (muted == sidebar in some themes). See
  style guide §2. Themed markdown: add `prose-accent` beside `prose` (§10).
- **No `window.prompt/confirm/alert`** — create/edit → `Dialog`; destructive confirm →
  `AlertDialog` (red action); feedback → `useToast()` (not inline error banners).
- **Bare icons inside `<Button>`** — no `mr-*`/`h-*/w-*` (base gives `gap-2` + `size-4`).
  `Button size="sm"` is `h-9`; match it with `ToggleGroup size="default"`.
- **Form submits use `<SubmitButton>`** (never bare `<Button type="submit">`) — descriptive
  verb+noun label ("Save agent", "Create event"; not "Save"), no "Saving…" text-swap; pass
  `pending={…}` for client forms, nothing for server-action forms. See style guide §6.
- **Reuse shared patterns** — `<BackLink>` (detail back link), `<SetPageTitle>` (centered
  top-bar title; no duplicate on-page `<h1>`), `<TagInput>`/`<TagPill>` (tags as `string[]`,
  themed colors), `<MarkdownEditor>` (edit) / `ReactMarkdown`+`prose` (render),
  `<ShareControl nodeId>` (read-only public-link toggle on any shareable detail header;
  pass `beforeEnable` to publish first — pages pass `commit`). See [`docs/sharing.md`](../../docs/sharing.md).
- **List search/filter/pagination is URL-driven (SSR)** — server page reads `q`/`page`/filters,
  calls `list({…,limit,offset})` + `count*()`; client uses `useListNav()` (`go(patch)`) +
  `<ListPager>`. Don't client-filter a loaded list. Reference: `/pages` (mirrored by tasks/events/secrets).
- **Public surface (`/s/[token]`)** lives outside the `(app)` group — no app shell, and it
  must scroll itself (`h-dvh overflow-y-auto`) because globals.css pins `html/body` to
  `overflow:hidden` for the shell. Pages render via the server `renderPageDoc` (sanitized
  HTML), not the client editor.
- **Fonts**: Inter everywhere (auto) is the UI body font — don't change that.
  The **wordmark + header page-title** are user-selectable from a display-font
  library (Settings → Appearance → Fonts); to add one, drop a face in
  `public/fonts/library/<key>.ttf` and add a row to `lib/display-fonts.ts` (the
  single registry — it drives the `@font-face` block, both pickers, and the
  runtime CSS-var override). Defaults: Bukhari wordmark, sans title.
- **Tailwind v4**: no dynamically built class names (use literal-string arrays).
- **Workflow**: `pnpm --filter @mantle/web run typecheck` before commit; commit on `main`
  with the `Co-Authored-By` trailer; don't push unless asked. To see changes in a
  browser without a local stack, run `pnpm dev:fe` (detached mode against the test
  box — [docs/db-less-dev.md](../../docs/db-less-dev.md)).
- **Detached mode must keep working**: server-side code in the `(app)` layout, pages,
  or auth path that reads the DB during render (direct `@mantle/db` or via helpers
  like `isOnboarded`) breaks `pnpm dev:fe` with a 500 — gate such reads behind
  `isDetachedDev()` (see docs/db-less-dev.md "How it works"). Client code fetches via
  `apiFetch`/`apiSend`/`apiEventStream` only (never raw same-origin `fetch` for data).

**Team Hub app** — `/hub` can render a designated mini-app full-bleed instead of
the built-in hub (Team admin → "Hub app"); `/team` itself is the read-only
member workspace (`components/team-workspace/`). The authoring contract (thin `host.hub`
SDK, sandbox rules, fallback chain) is [`docs/team-hub-app-sdk.md`](../../docs/team-hub-app-sdk.md);
the bridge protocol (`lib/app-bridge/protocol.ts`) and the `@host` kit string
(`packages/app-build/src/kit.ts`) MUST stay mirrored (tripwire: `kit.test.ts`).

**Changing what a brain ships with** (default agents, skills, tool groups, workers,
the persona) — there is ONE source of truth: the system manifest. Read
[`lib/system-manifest/CLAUDE.md`](lib/system-manifest/CLAUDE.md) first. Never
hardcode a model, prompt, grant, or worker in onboarding, a seed script, or the
runtime; change `lib/system-manifest/` and it propagates to fresh AND existing
brains.
