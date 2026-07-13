# Mantle UI / Theme Style Guide

A rulebook for keeping the `apps/web` front-end consistent. Read this before
doing any styling work. When in doubt, **match an existing screen** — Notes and
the settings screens (Agents, Tools, API keys, …) are the reference
**master-detail** implementations (§8); Appearance is the reference for theme
widgets.

> TL;DR — shadcn primitives, semantic theme tokens only (pair every fill with
> its OWN `-foreground`, never mix pairs), never native `prompt/confirm/alert`,
> bare icons inside buttons, toasts for feedback, and reuse the shared patterns
> below instead of reinventing them.

---

## 1. Philosophy

- **shadcn-first.** Compose UI from the primitives in `components/ui/*`. Reach
  for raw `<button>`/`<input>`/`<select>` only when no primitive fits (and then
  ask whether one should be added).
- **Token-first.** Style with semantic theme tokens, never hardcoded colors.
  The app ships ~40 color themes (tweakcn) × light/dark; hardcoded hex/oklch
  breaks all of them.
- **Self-hosted ethos.** No external CDNs for fonts/assets. Fonts are
  self-hosted via `next/font/local` (`lib/fonts.ts`).
- **Consistency over cleverness.** A new screen should feel like it was built
  by the same hand as the last one.

---

## 2. Color tokens

Use Tailwind utilities backed by the theme CSS variables (mapped in the
`@theme inline` block of `app/globals.css`). **Never** put a hex/oklch literal
in a component.

| Purpose | Tokens (`bg-`/`text-`/`border-`) |
|---|---|
| Page surface | `background`, `foreground` |
| Raised surface | `card`, `card-foreground`, `popover` |
| Brand / primary action | `primary`, `primary-foreground` |
| Secondary | `secondary`, `secondary-foreground` |
| Subtle / muted | `muted`, `muted-foreground` |
| Hover / highlight | `accent`, `accent-foreground` |
| Danger | `destructive`, `destructive-foreground` |
| Lines / fields | `border`, `input`, `ring` |
| Categorical data | `chart-1` … `chart-5` |

Rules:
- **Pair a fill with its OWN foreground — never mix pairs.** Each surface token
  has a guaranteed-contrast partner; use them together:
  `bg-primary`+`text-primary-foreground`, `bg-secondary`+`text-secondary-foreground`,
  `bg-accent`+`text-accent-foreground`, `bg-destructive`+`text-destructive-foreground`,
  `bg-muted`+`text-muted-foreground`, `bg-card`+`text-card-foreground`,
  `bg-background`+`text-foreground`. Mixing pairs (e.g. `bg-accent text-foreground`)
  has **no contrast guarantee** and silently breaks in themes whose `accent` is a
  light tint (candyland/soft-pop/neo-brutalism in dark mode → white-on-light).
  This applies to **hover and active fills too**: a coloured fill must bring its
  matching `-foreground` (e.g. `hover:bg-accent hover:text-accent-foreground`; for
  a fill on a row whose meta text is `text-muted-foreground`, flip it with
  `group-hover:text-accent-foreground`). Swept app-wide 2026-06-03.

  **Which fill where** — what each surface pair is *for* (reach for the right one,
  then text it with its own foreground):

  | Fill | Use it for |
  |---|---|
  | `bg-background` / `text-foreground` | the page itself |
  | `bg-card` / `text-card-foreground` | neutral raised panels, cards |
  | `bg-accent` / `text-accent-foreground` | a **soft highlighted surface** — accent cards, hover/active rows, chips that set BOTH tokens |
  | `bg-secondary` / `text-secondary-foreground` | a quieter filled chip / segmented control |
  | `bg-muted` / `text-muted-foreground` | the most subdued surface + secondary text on `background` |
  | `bg-primary` / `text-primary-foreground` | the single brand/action accent — primary buttons, the one thing that should pop. Don't tile large areas with it (it's saturated). |
  | `bg-destructive` / `text-destructive-foreground` | errors / destructive actions only |

  Rule of thumb: **`accent` is the "card accent"; `primary` is the single pop on
  top; `muted`/`secondary` are the quiet fills.** For a tinted-but-not-filled
  emphasis, a faint `bg-primary/10` (contrast-checked) is fine — but a *filled*
  coloured surface must bring its matching `-foreground`.
- **Semantic action colours come from tokens, not literal green/red.** Affirmative
  = `primary`, dangerous/removing = `destructive` (e.g. the sender approve/deny
  Button variants). A hardcoded `bg-green-600`/`bg-red-600` ignores the theme.
- **Opacity via the `/NN` modifier** (`bg-primary/10`, `border-chart-2/30`) —
  works through `color-mix`, fully theme-aware.
- **`chart-1..5`** is the categorical palette — use it for things that need
  distinct-but-themed colors (e.g. tag pills). Don't use `primary` for
  categorical sets.
- **Selected / active state — mark it with an ACCENT, not a background fill.**
  For list selection use a **left accent bar only**: `border-l-[3px]
  border-l-primary` (keep a visible `border-l-border` at rest so radius doesn't
  break; flip only the colour on select). **Do not add a `bg-accent` fill on the
  selected or hovered row** — in many themes `accent` is saturated and the row's
  text is `foreground`/`muted-foreground` (not `accent-foreground`), so the text
  becomes unreadable. For hover use a neutral `hover:bg-muted/50`. (Swept
  app-wide 2026-06-02; the borderless Contacts rows use a `border-l-2
  border-l-transparent` base so the accent bar doesn't shift text.) `bg-accent`
  is fine where text is paired with `accent-foreground` (e.g. a chip that sets
  both), and a faint `bg-primary/10` tint is acceptable when contrast is
  verified — but the default selection idiom is border-only.
- **Hover on a `bg-sidebar` surface (Activity column, nav):** `--sidebar` equals
  `--muted` in some themes, so `hover:bg-muted` is invisible there. Use a neutral
  overlay `hover:bg-foreground/[0.06]` — it differs from any sidebar value in
  light + dark and, being neutral, keeps grey `muted-foreground` text legible
  (a coloured `accent` tint muddies it).
- Light/dark is handled by `next-themes`; the color theme by
  `ColorThemeProvider` (`data-color-theme` on `<html>`, presets in
  `globals.css`, registry in `lib/themes.ts`). Don't fork theme logic.

---

## 3. Typography & fonts

- **Sans (everything):** Inter, self-hosted, wired as `--font-sans` on
  `<body>` via `lib/fonts.ts`. Just use default text — don't set font-family.
- **Logo / wordmark only:** Bukhari Script via `font-logo` (`--font-logo`).
  Do **not** use it for anything else — the centered top-bar page title is
  Inter (`text-lg font-bold text-chart-2`).
- `--font-serif` / `--font-mono` are fallback strings only (mono is fine for
  code/`font-mono`); no serif font is actually loaded.
- **Do not add per-theme fonts.** All themes share Inter by design.
- Headings: page title lives in the **top bar** (see §8) — don't add a big
  on-page `<h1>` that duplicates it. Section headings: `h2`,
  `text-base`/`text-lg font-semibold`.
- **Sizing — keep it readable.** Primary text `text-sm`, secondary/meta
  `text-xs`. Avoid `text-[10px]`/`text-[11px]` except for tiny corner
  tags/badges — list/table meta was deliberately bumped up a notch this round.

---

## 4. Component inventory (`components/ui/`)

Prefer these over hand-rolled markup:

`button`, `dialog`, `alert-dialog`, `dropdown-menu`, `input`, `label`,
`textarea`, `checkbox`, `badge`, `select`, `tabs`, `toggle` / `toggle-group`,
`tooltip`, `popover`, `card`, `avatar`, `separator`, `skeleton`, `switch`,
`slider`, `radio-group`, `command`, `sheet`, `table`, `toast`, `sidebar`,
`resizable`, `submit-button`.

Shared app-level patterns (`components/`):

- **`layout/back-link.tsx`** — `<BackLink href>` standard detail-page back link.
- **`layout/page-title.tsx`** — `<SetPageTitle title>` sets the centered top-bar
  title (no on-page duplicate needed).
- **`tag-pill.tsx`** — `<TagPill tag>` + `tagColorClass()` (themed tag color).
- **`tag-input.tsx`** — `<TagInput value onChange>` pill tag editor (`string[]`).
- **`markdown-editor.tsx`** — `<MarkdownEditor value onChange>` toolbar +
  split/preview editor.
- **`ui/toast.tsx`** — `useToast()` for all feedback.

---

## 5. Buttons & icons

- Use `<Button>` with `variant` (`default|secondary|outline|ghost|destructive|
  link`) and `size` (`default|sm|lg|icon`). For links styled as buttons:
  `<Button asChild><Link …/></Button>`.
- **Icons inside buttons are bare:** `<Button><Plus /> New</Button>`. The
  Button base already supplies `gap-2` spacing and auto-sizes SVGs to `size-4`.
  **Do NOT** add `mr-*`/`ml-*` or `h-*/w-*` to an icon inside a Button — it
  double-spaces and fights the base. (Standalone icons outside buttons may keep
  margins/sizes.)
- **Heights line up at `h-9`:** `Button size="sm"` is `h-9`; the matching
  `ToggleGroup` size is `default` (also `h-9`), **not** `sm` (`h-8`). Match
  sibling controls.
- Icon-only buttons: `size="icon"` + an `aria-label`.
- Icons come from `lucide-react`. Decorative icons get `aria-hidden`.

---

## 6. Forms

- `Label` + field wrapped in `space-y-1.5`; stack fields with `space-y-4`.
- Use `Input`, `Textarea` (not raw elements). Tag fields use `<TagInput>`.
- **Date / time entry uses `<DateTimePicker value onChange clearable?>`**
  (`components/ui/date-time-picker.tsx`) — the shadcn Calendar in a popover +
  a time field. Don't use the native `datetime-local` input (used by events +
  heartbeats; value is a `Date | null`).
- **Every form submit uses `<SubmitButton>`** (`components/ui/submit-button.tsx`)
  — never a bare `<Button type="submit">`. It standardises the two things a
  save button must do:
  - **Descriptive label — verb + noun.** "Save agent", "Save profile",
    "Create event", "Save key" — never a bare "Save"/"Create", and the label
    does **not** change while saving (no "Saving…" text-swap). The user should
    always read *what* the button persists.
  - **In-flight feedback.** While the submit runs the button disables itself
    and shows a leading spinner; the label stays put (no layout reflow).
  - **Driving the busy state:** client forms (the common case — `fetch` +
    `useState`/`useTransition`) pass `pending={saving}`. Server-action forms
    (`<form action={…}>`) pass nothing — `SubmitButton` reads `useFormStatus`.
  - For create/edit dialogs, switch the label on mode:
    `{mode === 'create' ? 'Create agent' : 'Save agent'}`.
- **Multi-select → `<ToggleList>`** (`components/toggle-list.tsx`), not a wall of
  pills. Each row is a non-interactive container (name + description + a real
  shadcn `<Switch>`); **the Switch is the only control — clicking the row body
  does nothing** (explicit toggle, no whole-row click) and there is **no hover
  fill** (on-state shows a `border-l-primary` bar). Optional `group` clusters rows
  under sub-headers. It flows inline in the page (no inner scroll); pass
  `collapsible` to fold a long catalog behind a header that shows the
  `N of M selected` count, and `searchable` for a filter bar (text search + an
  All / On / Off selection filter, shown once a list exceeds ~6 items). Used by
  the agents Tools/Skills/Delegates pickers and AI workers.

---

## 7. Dialogs, confirmations & feedback

- **Never use `window.prompt` / `window.confirm` / `window.alert`.**
- **Creating / editing** → `Dialog`. Constrain width (default `DialogContent`
  is wide): `className="sm:max-w-md"` / `sm:max-w-2xl`.
- **Destructive confirmation** → `AlertDialog`. Style the action red:
  `<AlertDialogAction className="bg-destructive text-destructive-foreground
  hover:bg-destructive/90">`.
- **Feedback** → `useToast()`: `toast.success('Saved')`, `toast.error(msg)`.
  Prefer toasts over inline error banners for transient outcomes. Don't blow
  away a loaded view to show an error.
- Opening a Dialog/AlertDialog from a `DropdownMenuItem`: keep the dialog as a
  separate state-controlled component (not nested in the menu) to avoid Radix
  focus/pointer-events lockups.

---

## 8. Page layout & the master-detail pattern

### Centered content pages
Simple/standalone pages: `mx-auto max-w-{2xl..6xl} space-y-6 px-6 py-8`.

### Collapsible shell rails (`--nav-w` / `--activity-w`)
The left nav and right Activity column collapse to a 3.5rem icon rail. Their
live widths are published by `AppShell` as the `--nav-w` / `--activity-w` CSS
variables on the shell root (with matching `data-{nav,activity}-collapsed`).
**Any element that frames the content by offsetting against a rail must use the
vars, never a hardcoded `md:left-64` / `lg:right-80`** — e.g. `md:left-[var(--nav-w)]
lg:right-[var(--activity-w)]` (see `main`, `FleetLayout`, the mail shell). A new
full-screen fixed overlay that hardcodes the width will silently break collapse.
Descendants that need to restyle when collapsed key off the root via
`group-data-[nav-collapsed=true]/shell:…` (the mobile drawer portals outside the
root, so it always renders expanded). Shortcuts: **⌘/Ctrl+B** toggles the nav,
**⌘/Ctrl+J** toggles Activity (suppressed while typing/editing, so ⌘B still bolds
in the page editor).

### Footer status bar (`--footer-h`)
A full-width bottom bar (`FooterBar`, `components/layout/footer-bar.tsx`) is the
shell's single control strip. Height is published as **`--footer-h`** on the
shell root, and **every full-height fixed region must end at
`bottom-[var(--footer-h)]`** (not `bottom-0`) so its content never hides behind
the bar — `main`, the sidebar, the Activity rail, the assistant panel,
`FleetLayout`, and the mail shell all do. Layout: **start** = sidebar collapse
toggle (⌘B), **centre** = the five most-used menus (ranked from local usage —
`lib/nav-usage.ts`, keyed off the shared nav list in `layout/nav-items.ts`),
**end** = the Highlight-content + Assistant launchers, the full-display ⇄
side-column dock toggle (only while the assistant is open), then the Activity
collapse toggle (⌘J). The two collapse toggles live here, not on the rails they
control — icon-only, mirrored so they read as a symmetric pair.

### Full-height pages
The app `<main>` is a fixed, full-height `overflow-y-auto scrollbar-thin`
region. For full-height screens the **page wrapper returns the client directly**
(no `max-w` box; just `<><SetPageTitle/><Client/></>`) and the root takes the
height. **Every flex/grid scroll pane must carry `min-h-0`** — grid items and
flex children default to `min-height:auto`, so without it the pane grows to its
content and `<main>` scrolls *behind* it (the dreaded double scrollbar / bottom
gap / cut-off). `min-h-0` is necessary but **not sufficient**: a correctly-sized
but `position:static` `overflow-y-auto` pane still leaks its scrollable overflow
into `<main>` when its content is far taller than the viewport — so the actual
scroll container (the detail pane) must also be `relative` (see the master-detail
rules below). Use `scrollbar-thin` on scroll areas (`scrollbar-hidden` also
exists; both are utilities in `globals.css`).

### Master-detail — THE pattern for list+editor screens
Used by **Notes, Traces, Secrets, Events, Tasks**, and every settings list
screen: **Accounts, Agents, AI workers, Heartbeats, Skills, Tools, API keys.**
Left = scrollable list of **accent cards**; right = detail/form for the selected
item. Proven scaffold (double-scrollbar-free):

```tsx
<div className="md:grid md:h-full md:grid-cols-[340px_1fr] md:overflow-hidden">
  {/* LEFT: list */}
  <div className="flex flex-col border-b border-border md:h-full md:min-h-0 md:border-b-0 md:border-r">
    <div className="flex items-center justify-between gap-2 border-b border-border p-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Things</h2>
      <Button size="sm" onClick={openCreate}><Plus /> New</Button>
    </div>
    <div className="space-y-2 p-3 md:flex-1 md:overflow-y-auto md:scrollbar-thin">
      {items.map((it) => /* accent card */)}
    </div>
    {/* optional fixed footer, e.g. pager */}
  </div>
  {/* RIGHT: editor / detail — `relative` is load-bearing, see rule below */}
  <div className="relative md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
    {selected ? /* editor */ : /* empty state */}
  </div>
</div>
```

Rules:
- **Both panes need `md:min-h-0`** (see double-scrollbar note above). Left is a
  flex column; only its list div scrolls (`md:flex-1 md:overflow-y-auto`).
- **The scrolling detail pane needs `relative`** (`position` only — no other
  effect). `min-h-0` correctly sizes the pane to the grid track, but a
  `position:static` `overflow-y-auto` pane still lets its *scrollable overflow*
  propagate up to `<main>` when its content is much taller than the viewport —
  producing a **second, outer scrollbar** that overlaps and clips the editor.
  Making the pane a positioned element (`relative`) closes that boundary so only
  the pane scrolls. Symptom: two stacked scrollbars on the right pane, the outer
  one cutting off text. This bit tool-groups/skills/tools (whose tall tool-picker
  lists pushed content to ~8000px) — agents never had it because its pane was
  already `relative`. Always include `relative` on the detail pane.
- **Accent card** (selectable list item) — keep the left border *visible* so
  rounded corners don't break; only its colour flips on select:
  ```tsx
  <button className={cn(
    'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-muted/50',
    selected && 'border-l-primary',   // accent bar only — no bg-accent fill (see §2)
    disabled && 'opacity-70',
  )} />
  ```
- **Auto-select the first item** so the right pane is never blank:
  `selected ?? items[0]`.
- **Editor header (right pane):** title + one-line description on the left;
  top-right holds boolean flags as shadcn **`Switch`es** (Enabled,
  Default-for-kind, …) and a ghost **Delete** (`text-destructive`). Form body
  has the rest; Save/Cancel footer. Delete → `AlertDialog`. Don't put the
  Enabled toggle in the form body — it lives in the header.
- **Selection model — pick one:**
  - *Client state* when the list rows already hold everything the detail needs
    (e.g. Notes rows include content) → instant, no fetch. `useState` for
    selection; re-derive the selected object from fresh props each render so
    saves reflect immediately.
  - *URL-driven* (`?selected=id`, `?mode=add|edit|…`) when the detail needs a
    server fetch or reuses server-action forms (Traces, AI workers, Accounts) →
    cards are `<Link>`s, the server page renders the right pane. Make a create
    action redirect back to `?selected=<newId>` so it lands on the same screen.
- **Grouped lists** (AI workers by kind, Tools builtin/user-defined) → sections
  inside the left scroll area, each with its own sub-header / `+ Add`.
- **Read-only oversight:** when a record's fields are code/seed-managed (built-in
  tools), still let it be selected and show the fields **read-only** (disabled
  inputs / muted blocks); only send the editable subset on save.
- **Search / filter / pagination are URL-driven (SSR), not client-side.** The
  reference is `/pages`; `/tasks`, `/events`, `/secrets` follow it. The server
  page reads `q` / `page` / filters from `searchParams`, calls
  `list({ …filters, limit, offset })` + a `count*()`, and passes
  `rows / total / page / pageSize / query / filters` to the client. The client
  uses the **`useListNav()`** hook (`go(patch)` merges into the query string;
  `null` clears a key, and filter/search changes pass `page: null` to reset),
  a debounced search input, and **`<ListPager>`** (footer count + prev/next,
  shown whenever there are rows). Don't filter a loaded list in `useMemo` —
  paginating a client-filtered slice is wrong.

### Detail (deep-link) pages
Start with `<BackLink href>`; title via `<SetPageTitle>`. **Keep these working
as deep links** even after a master-detail supersedes the in-app navigation
(e.g. `/traces/[id]`, `/settings/accounts/[id]/*`) — other screens link to them.

### Radius / spacing
`rounded-md` (controls), `rounded-lg` (cards); gaps in multiples of `0.25rem`
(`gap-1.5`, `gap-2`, `space-y-4`).

---

## 9. Tags

- Stored and passed as `string[]` (not comma strings).
- **Edit:** `<TagInput value onChange>` — comma/Enter commits a pill, Backspace
  removes last, paste splits on commas; normalizes lowercase + dedupes.
- **Display:** `<TagPill tag>` — deterministic color from `chart-1..5` via
  `tagColorClass(tag)` (same tag → same color, recolors with the theme).

---

## 10. Markdown

- **Editing:** `<MarkdownEditor>` (toolbar + Edit/Split/Preview + live preview).
- **Rendering:** `ReactMarkdown` + `remarkGfm` inside
  `prose prose-sm dark:prose-invert max-w-none`.
- **Theme-accented prose — add `prose-accent`** next to `prose` to brighten the
  flat black-and-white markdown with theme tokens: gradient h1
  (`primary`→`chart-3`), `primary` h2 + divider, h3/h4 accents, primary links,
  tinted inline-code chips, accent-bar blockquote, coloured list markers, gradient
  hr. Defined in `globals.css` (one block, all CSS-var driven, recolours with
  every theme × light/dark). It's **opt-in**: docs reader, Notes (read + public
  share), and Pages (editor + read + public) add it; the Pages editor surface is
  `prose` **and** `ProseMirror`, so it also picks up Pages-only `.ProseMirror`
  polish — code-block cards (`--muted` panel + 3px `primary` spine), a `primary`
  caret (which keeps the *transparent* gradient h1 editable), and a themed text
  selection. Selectors are class+element so they outrank Typography's `:where()`
  rules without `!important`. Don't hand-style headings per-surface — add the class.

---

## 11. Tailwind v4 gotchas

- **No dynamically constructed class names.** The scanner only sees literal
  strings, so `bg-chart-${n}` will NOT generate. Keep a literal array (see
  `tag-pill.tsx`'s `TAG_COLORS`) and index into it.
- Content is auto-detected (no `tailwind.config`); literal classes anywhere in
  source are picked up.
- Opacity modifiers on theme tokens work via `color-mix` — safe to use.

---

## 12. Accessibility

- Icon-only buttons/links need `aria-label`; decorative icons get `aria-hidden`.
- Confirm destructive actions (AlertDialog), don't rely on hover-only controls
  as the sole affordance.
- Respect focus rings (`focus-visible:ring-*` is built into the primitives —
  don't strip it).

---

## 13. Workflow

- **Typecheck before committing:** `pnpm --filter @mantle/web run typecheck`
  (and `--filter @mantle/content` etc. if you touched a shared package).
- Work in a git worktree; auto commit + ff-merge into `main` after each change.
  **Don't push unless asked.** Commit messages end with the project's
  `Co-Authored-By` trailer.
- Remove dead code you replace (unused imports, orphaned components) — e.g.
  the old `PageHeader` and `tree-rail` were deleted when superseded.
- Prefer extracting a reusable component (like `BackLink`, `TagPill`) the
  second time a pattern appears, then adopt it everywhere for consistency.

---

## 14. Anti-patterns (don't do these)

- ❌ Hardcoded colors (`#fff`, `text-[oklch(...)]`, `bg-gray-200`), including
  literal `bg-green-600`/`bg-red-600` for approve/deny — use `primary`/`destructive` (§2).
- ❌ Mixing a fill with a foreign foreground — `bg-accent text-foreground`,
  `hover:bg-accent hover:text-foreground` — pair each fill with its own
  `-foreground` (§2). Breaks on light-accent themes.
- ❌ A coloured-`accent` hover on a `bg-sidebar` surface (muddies grey text) —
  use a neutral `hover:bg-foreground/[0.06]` (§2).
- ❌ `window.prompt/confirm/alert`.
- ❌ A bare `<Button type="submit">` in a form, a bare "Save"/"Create" label,
  or a "Saving…" text-swap — use `<SubmitButton pending={…}>Save <noun></SubmitButton>` (§6).
- ❌ `mr-1 h-3.5 w-3.5` (or any margin/size) on an icon inside a `<Button>`.
- ❌ Native `<select>`/`<input type=checkbox>` when `Select`/`Checkbox` exist.
- ❌ Inline error banners for transient failures (use toasts).
- ❌ A big on-page `<h1>` duplicating the top-bar page title.
- ❌ Per-theme or decorative fonts beyond Inter + the Bukhari logo.
- ❌ Dynamically built Tailwind class names.
- ❌ A flex/grid scroll pane without `min-h-0`, or a master-detail detail pane
  without `relative` (either causes a second, outer scrollbar — see §8).
- ❌ `text-[10px]`/`text-[11px]` for normal list/table text (use `text-xs`+).
- ❌ The Enabled toggle buried in the form body on a master-detail editor — it
  goes top-right in the header as a `Switch`.
