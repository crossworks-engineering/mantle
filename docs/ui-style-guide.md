# Mantle UI / Theme Style Guide

A rulebook for keeping the `apps/web` front-end consistent. Read this before
doing any styling work. When in doubt, **match an existing screen** — Notes and
the settings screens (Agents, Tools, API keys, …) are the reference
**master-detail** implementations (§8); Appearance is the reference for theme
widgets.

> TL;DR — shadcn primitives, semantic theme tokens only, never native
> `prompt/confirm/alert`, bare icons inside buttons, toasts for feedback,
> and reuse the shared patterns below instead of reinventing them.

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
- **Opacity via the `/NN` modifier** (`bg-primary/10`, `border-chart-2/30`) —
  works through `color-mix`, fully theme-aware.
- **`chart-1..5`** is the categorical palette — use it for things that need
  distinct-but-themed colors (e.g. tag pills). Don't use `primary` for
  categorical sets.
- **Selected / active state:** `border-primary` (often with `ring-1
  ring-primary` or `bg-accent/50`). For list selection use a **left accent**:
  `border-l-[3px] border-l-primary` + `bg-accent/50`.
- Light/dark is handled by `next-themes`; the color theme by
  `ColorThemeProvider` (`data-color-theme` on `<html>`, presets in
  `globals.css`, registry in `lib/themes.ts`). Don't fork theme logic.

---

## 3. Typography & fonts

- **Sans (everything):** Inter, self-hosted, wired as `--font-sans` on
  `<body>` via `lib/fonts.ts`. Just use default text — don't set font-family.
- **Logo / wordmark + centered page title only:** Bukhari Script via
  `font-logo` (`--font-logo`). Do **not** use it for body copy.
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
- Submit buttons show progress (`disabled`, `Saving…`). For server-action
  forms, `components/ui/submit-button.tsx` handles pending state.

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

### Full-height pages
The app `<main>` is a fixed, full-height `overflow-y-auto scrollbar-thin`
region. For full-height screens the **page wrapper returns the client directly**
(no `max-w` box; just `<><SetPageTitle/><Client/></>`) and the root takes the
height. **Every flex/grid scroll pane must carry `min-h-0`** — grid items and
flex children default to `min-height:auto`, so without it the pane grows to its
content and `<main>` scrolls *behind* it (the dreaded double scrollbar / bottom
gap / cut-off). Use `scrollbar-thin` on scroll areas (`scrollbar-hidden` also
exists; both are utilities in `globals.css`).

### Master-detail — THE pattern for list+editor screens
Used by **Notes, Traces, Secrets, Events, Todos**, and every settings list
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
  {/* RIGHT: editor / detail */}
  <div className="md:h-full md:min-h-0 md:overflow-y-auto md:scrollbar-thin">
    {selected ? /* editor */ : /* empty state */}
  </div>
</div>
```

Rules:
- **Both panes need `md:min-h-0`** (see double-scrollbar note above). Left is a
  flex column; only its list div scrolls (`md:flex-1 md:overflow-y-auto`).
- **Accent card** (selectable list item) — keep the left border *visible* so
  rounded corners don't break; only its colour flips on select:
  ```tsx
  <button className={cn(
    'block w-full rounded-lg border border-l-[3px] border-border border-l-border bg-card p-2.5 text-left transition-colors hover:bg-accent/40',
    selected && 'border-l-primary bg-accent/50',
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

- ❌ Hardcoded colors (`#fff`, `text-[oklch(...)]`, `bg-gray-200`).
- ❌ `window.prompt/confirm/alert`.
- ❌ `mr-1 h-3.5 w-3.5` (or any margin/size) on an icon inside a `<Button>`.
- ❌ Native `<select>`/`<input type=checkbox>` when `Select`/`Checkbox` exist.
- ❌ Inline error banners for transient failures (use toasts).
- ❌ A big on-page `<h1>` duplicating the top-bar page title.
- ❌ Per-theme or decorative fonts beyond Inter + the Bukhari logo.
- ❌ Dynamically built Tailwind class names.
- ❌ A flex/grid scroll pane without `min-h-0` (causes a second, outer
  scrollbar — see §8).
- ❌ `text-[10px]`/`text-[11px]` for normal list/table text (use `text-xs`+).
- ❌ The Enabled toggle buried in the form body on a master-detail editor — it
  goes top-right in the header as a `Switch`.
