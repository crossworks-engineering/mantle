# Mantle UI / Theme Style Guide

A rulebook for keeping the `apps/web` front-end consistent. Read this before
doing any styling work. When in doubt, **match an existing screen** — Notes,
Files, and Appearance are the reference implementations.

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

## 8. Page layout patterns

- **Centered content pages** (settings, forms, simple lists):
  `mx-auto max-w-{2xl..6xl} space-y-6 px-6 py-8`.
- **Full-height / split pages** (Files, Notes): the app `<main>` is a fixed
  full-height, `overflow-y-auto scrollbar-thin` region. Make the page's root
  `h-full` and let inner panes scroll:
  ```tsx
  <div className="md:grid md:h-full md:grid-cols-2 md:overflow-hidden">
    <div className="flex flex-col md:h-full md:min-h-0 md:border-r …">
      {/* header (fixed) */}
      <div className="md:flex-1 md:overflow-y-auto md:scrollbar-thin">…</div>
      {/* footer (fixed) */}
    </div>
    <div className="md:h-full md:overflow-y-auto md:scrollbar-thin">…</div>
  </div>
  ```
  (The page wrapper for these returns the client directly — no `max-w` box.)
- **Master-detail** (Notes): list of cards left, live preview right; selected
  card gets the left primary accent; the preview reads already-loaded data
  (no extra fetch) and defaults to the first row.
- **Scrollbars:** use `scrollbar-thin` on scroll areas (`scrollbar-hidden`
  exists too). Both are utilities in `globals.css`.
- **Detail pages** start with `<BackLink href>`; the page title goes in the top
  bar via `<SetPageTitle>`.
- **Radius/spacing:** `rounded-md` (controls), `rounded-lg` (cards); gaps in
  multiples of `0.25rem` (`gap-1.5`, `gap-2`, `space-y-4`).

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
