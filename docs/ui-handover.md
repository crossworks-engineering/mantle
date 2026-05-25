# UI work — handover (open items)

Continuation notes for the next session. The big push (settings master-detail
rework) is **done and shipped**; this is the tail.

**Read first:** [`docs/ui-style-guide.md`](./ui-style-guide.md) — esp. **§8
(master-detail pattern)**. `apps/web/CLAUDE.md` auto-loads the non-negotiables.
Match existing screens (Notes, Agents, Tools) when unsure.

## Git state at handover
- Branch `main`, working tree clean.
- **HEAD `a4f5c52`, 1 commit ahead of `origin/main` → push it** when you start.
- Per-change workflow: typecheck (`pnpm --filter @mantle/web run typecheck`),
  commit on `main` with the `Co-Authored-By` trailer, push only when asked.

## Done (for context — don't redo)
Master-detail (accent list left + editor/detail right, header `Switch` for
Enabled/flags, AlertDialog deletes, toasts, larger fonts, full-height with
`min-h-0`): **Notes, Traces, Accounts, Agents, AI workers, Heartbeats, Skills,
Tools (built-ins editable/oversight), API keys.** Debug split into tabbed
sub-pages. Style guide + CLAUDE.md updated.

---

## Open items (priority order)

### 1. `settings/senders` — apply the screen treatment (biggest remaining)
The only settings screen not yet reworked. Files:
- `app/(app)/settings/senders/page.tsx` (207, server — the list/curation UI)
- `manual-entry.tsx` (96), `preview-button.tsx` (220), `search-box.tsx` (78),
  `actions.ts`
Senders is a **curation/approval** surface (approve/deny pending senders,
search, likely pagination) — not a 1:1 editor list, so **master-detail may not
fit literally**. Recommended: keep it list-centric but bring it up to standard —
shadcn `Button`/`Input`/`Badge`, `AlertDialog` for any destructive confirm,
`toast` feedback, `text-sm/xs` (no 10/11px), `scrollbar-thin`, theme tokens.
Read `page.tsx` + `actions.ts` first to learn the approve/deny flow before
restyling. Don't force a left/right split if it hurts the curation UX — judgement
call; document the choice.

### 2. Native `<select>` → shadcn `Select` (guide §4/§14 anti-pattern)
`components/ui/select.tsx` exists (`Select`/`SelectTrigger`/`SelectValue`/
`SelectContent`/`SelectItem`). Convert these native selects (controlled:
`value` + `onValueChange`). Do per-file, commit per-file:
- `app/(app)/settings/keys/keys-client.tsx` — provider dropdown (create form).
- `app/(app)/settings/tools/tools-client.tsx` — `kind` (http/shell) + http `method`.
- `app/(app)/settings/heartbeats/heartbeats-client.tsx` — `agent` + `skill`
  selects are the **only** remaining heartbeats cleanup. Otherwise it's already
  conformant (master-detail, AlertDialog deletes, toast, `min-h-0`, accent
  cards — done by a parallel session). It has **no Enabled `Switch` by design**:
  heartbeats use a status enum (active/paused/completed/cancelled) with
  Pause/Resume + Fire-now actions, not a boolean. Re-read before editing.
- `app/(app)/settings/agents/agents-client.tsx` — `role`, API-key, embedding-model.
- `app/(app)/settings/agents/persona-notes-editor.tsx` — note `kind` select.
- `app/(app)/settings/ai-workers/worker-form.tsx` — apiKey/provider/model/voice
  selects (largest; 1217 lines — convert carefully, keep the model-discovery
  and voice-reactive logic intact).
Gotcha: shadcn `Select` doesn't post a native form value — these are all
controlled React state already, so fine, but if any select relied on
`new FormData(form)` (e.g. worker-form builds FormData), set the value
explicitly like it already does for `kind`.

### 3. `notes/[id]` — drop the "Indexed summary" callout (trivial)
`app/(app)/notes/[id]/note-detail-client.tsx` ~lines 125–131: remove the
`{note.summary && (<aside>… Indexed summary …</aside>)}` block to match the
`/notes` preview (which no longer shows it), and drop the now-unused `Sparkles`
import (line 7). One small edit + import cleanup.

---

### 4. Tech debt — oversized files (split, don't rewrite)
Some client components grew large during the refactors and are worth breaking up
for readability/maintainability (behaviour unchanged — pure extraction, commit
per split, typecheck between):
- **`app/(app)/settings/agents/agents-client.tsx` — ~1664 lines (worst offender).**
  Extract: the 4 `DEFAULT_*_PROMPT` strings → a `prompts.ts` constants module;
  the `NodeTypePicker` / `ToolPicker` / `SkillPicker` sub-components → their own
  files; ideally the `<form>` body → an `AgentForm` component, leaving
  `agents-client` as just the master-detail shell. Types (`AgentSummary`,
  `FormState`, `MemoryConfig`) can move to a `types.ts`.
- **`app/(app)/settings/ai-workers/worker-form.tsx` — ~1234 lines.** Per-kind
  field sets (`LlmWorkerFields`, `VisionFields`, `ImageGenFields`, TTS/STT) →
  separate files; keep the model-discovery/voice logic intact.
- `files-client.tsx` (857), `heartbeats-client.tsx` (811), `assistant-client.tsx`
  (725) are large but lower priority — split only if you're already in there.
- **`app/globals.css` (~3463 lines) is large *by design*** — it's the ~40 tweakcn
  theme presets. Don't "clean" it; leave the presets alone.

## Other notes
- `trace-detail-view.tsx` gained parent/child delegation links (committed in
  `a4f5c52`) — leave as is.
- A few `components/examples/*` demo files still have the old icon spacing; they
  may be unused — low priority, verify before touching.
