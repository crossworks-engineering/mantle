# apps/web — UI conventions

**Before any styling/UI work, read [`docs/ui-style-guide.md`](../../docs/ui-style-guide.md).**
It's the rulebook; match existing screens (Notes, Files, Appearance) when unsure.

Non-negotiables (full detail in the guide):

- **shadcn-first** — compose from `components/ui/*`; avoid raw `<button>`/`<input>`/`<select>`.
- **Theme tokens only** — `bg-background`, `text-foreground`, `text-muted-foreground`,
  `bg-card`, `border-border`, `bg-primary`, `bg-accent`, `bg-destructive`, `chart-1..5`.
  **Never hardcode colors**; opacity via `/NN`. Hardcoded colors break the ~40 themes.
- **No `window.prompt/confirm/alert`** — create/edit → `Dialog`; destructive confirm →
  `AlertDialog` (red action); feedback → `useToast()` (not inline error banners).
- **Bare icons inside `<Button>`** — no `mr-*`/`h-*/w-*` (base gives `gap-2` + `size-4`).
  `Button size="sm"` is `h-9`; match it with `ToggleGroup size="default"`.
- **Reuse shared patterns** — `<BackLink>` (detail back link), `<SetPageTitle>` (centered
  top-bar title; no duplicate on-page `<h1>`), `<TagInput>`/`<TagPill>` (tags as `string[]`,
  themed colors), `<MarkdownEditor>` (edit) / `ReactMarkdown`+`prose` (render).
- **Fonts**: Inter everywhere (auto); `font-logo` (Bukhari) only for the wordmark + centered
  title. Don't add fonts.
- **Tailwind v4**: no dynamically built class names (use literal-string arrays).
- **Workflow**: `pnpm --filter @mantle/web run typecheck` before commit; commit on `main`
  with the `Co-Authored-By` trailer; don't push unless asked.
