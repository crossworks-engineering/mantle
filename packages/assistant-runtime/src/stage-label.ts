/**
 * Map a trace-step `name` (+ optional input args) to a short, grounded status
 * label — the live "what is the agent doing right now" line.
 *
 * Shared by the producer (apps/api, which publishes `status` events as steps
 * start) and the web poll fallback (apps/web/lib/assistant/turn-stage.ts) so both
 * speak with one voice. Granularity is deliberately coarse — a handful of stages
 * a user actually waits on (thinking, searching, delegating, writing). When the
 * step's input carries a safe, query-ish field we enrich the label with it
 * ("Searching your brain for “Acme SLA”…", "Saving “Q3 plan” to your
 * notes…"); otherwise we use the bucket.
 *
 * Step names come from the tool loop (packages/agent-runtime/src/tool-loop.ts):
 *   - `<adapter>_chat`, `..._chat[2]`, `..._chat[force_final]` → an LLM call
 *   - `tool: <slug>`          → a tool dispatch (bucketed by slug)
 *   - `spill_result: <slug>`  → result paging
 */

export interface StageLabel {
  /** User-facing line ("Searching your brain for “Acme SLA”…"). */
  label: string;
  /** Coarse bucket the UI themes/iconifies. `write` (notes/tasks/pages),
   *  `calendar` (events), `message` (telegram/email sends), and `file` give the
   *  common write actions their own glyph instead of a generic tool wrench. */
  kind:
    'thinking' | 'web' | 'brain' | 'delegate' | 'tool' | 'write' | 'calendar' | 'message' | 'file';
}

/**
 * The thinking-phase label. A single honest line — the old rotating "phrases"
 * ("Mulling it over…", "Connecting the dots…") were theatre: canned text seeded
 * by step index with no connection to what the model was actually reasoning
 * about. The real reasoning trace (streamed `reasoning-delta`, rendered as a
 * collapsible "Thinking" disclosure) is now the source of truth for this phase;
 * this label is just the header shown while it streams (or on its own when the
 * model emits no surfaced reasoning).
 */
export const THINKING_LABEL = 'Thinking…';

/** Keys whose name alone marks a value as secret — never echoed into a label. */
const SENSITIVE = /secret|token|password|passwd|api[-_]?key|auth|bearer|credential/i;

/** Pull the first safe, non-empty string under one of `keys`, trimmed + capped.
 *  Only named keys are ever surfaced, so arbitrary/secret args can't leak into a
 *  status line. */
function pickString(
  input: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | null {
  if (!input) return null;
  for (const k of keys) {
    if (SENSITIVE.test(k)) continue;
    const v = input[k];
    if (typeof v !== 'string') continue;
    const s = v.trim().replace(/\s+/g, ' ');
    if (!s) continue;
    return s.length > 48 ? `${s.slice(0, 47)}…` : s;
  }
  return null;
}

/** Query-ish fields a search/recall tool puts the user's intent under. */
const QUERY_KEYS = ['query', 'q', 'search', 'term', 'text', 'question', 'title'] as const;
/** Where invoke_agent carries the specialist it's delegating to. */
const AGENT_KEYS = ['agent', 'agent_slug', 'slug', 'name', 'target'] as const;
/** Title-ish fields a write tool puts the subject under (for "Saving “…”"). */
const TITLE_KEYS = ['title', 'name', 'summary', 'subject', 'filename', 'q', 'query'] as const;

/** Specific, friendly labels for the common write/action tools the responder
 *  calls. Read/search tools are handled by pattern above this table. */
const ACTION_LABELS: Record<string, string> = {
  note_create: 'Adding to your notes…',
  note_update: 'Updating a note…',
  note_delete: 'Deleting a note…',
  task_create: 'Adding a task…',
  task_update: 'Updating a task…',
  task_delete: 'Removing a task…',
  event_create: 'Adding to your calendar…',
  event_update: 'Updating an event…',
  event_delete: 'Removing an event…',
  journal_create: 'Saving to your journal…',
  folder_create: 'Creating a folder…',
  file_upload: 'Saving a file…',
  file_read: 'Reading a file…',
  file_get: 'Reading a file…',
  file_delete: 'Deleting a file…',
  file_rename: 'Renaming a file…',
  web_fetch: 'Reading a web page…',
  // Draft commits/discards: no verb-fallback pattern matches `_commit` /
  // `_discard_draft`, and "Working on it…" undersells the one moment content
  // becomes visible (or a proposed edit is dropped).
  page_commit: 'Publishing the page…',
  page_discard_draft: 'Discarding the draft…',
  table_commit: 'Publishing the table…',
  telegram_send: 'Sending a message…',
  email_send: 'Sending an email…',
  email_get: 'Reading an email…',
  email_list: 'Checking your email…',
};

/** Where a `<thing>_create` lands, for the "Saving “…” <noun>" enrichment. */
const CREATE_NOUN: Record<string, string> = {
  note: 'to your notes',
  event: 'to your calendar',
  task: 'to your tasks',
  journal: 'to your journal',
  folder: 'as a folder',
  file: 'to your files',
  page: 'as a page',
};

/** Pick the icon bucket for a write/action tool from its slug, so each kind of
 *  action gets a fitting glyph in the trail (a pencil for notes, a calendar for
 *  events, …) rather than one generic wrench. */
function actionKind(slug: string): StageLabel['kind'] {
  if (slug.startsWith('event')) return 'calendar';
  if (slug.startsWith('file')) return 'file';
  if (slug.startsWith('telegram') || slug.startsWith('email')) return 'message';
  if (/^(note|task|journal|page|folder|table)/.test(slug)) return 'write';
  return 'tool';
}

/** A tool step logs its input as `{ slug, args }`; the user-facing values live
 *  under `args`. Unwrap it (falling back to the object itself for any flat
 *  caller) so enrichment reads `args.q`, not a non-existent top-level `q`. */
function toolArgs(input?: Record<string, unknown>): Record<string, unknown> | undefined {
  const a = input?.args;
  return a && typeof a === 'object' ? (a as Record<string, unknown>) : input;
}

/** Map a `tool: <slug>` dispatch to its stage label. Search/delegate tools read
 *  the query/agent; write tools name the action (and, when present, the subject)
 *  so the trail reflects what actually changed — "Adding to your notes…" rather
 *  than a generic "Working on it…". Unknown tools fall back to a verb guess. */
function toolStage(slug: string, args?: Record<string, unknown>): StageLabel {
  if (slug === 'invoke_agent') {
    const who = pickString(args, AGENT_KEYS);
    return {
      label: who ? `Delegating to ${who}…` : 'Delegating to a specialist…',
      kind: 'delegate',
    };
  }
  if (slug === 'web_search') {
    const q = pickString(args, QUERY_KEYS);
    return { label: q ? `Searching the web for “${q}”…` : 'Searching the web…', kind: 'web' };
  }
  if (slug === 'web_fetch') return { label: 'Reading a web page…', kind: 'web' };
  if (/^(search|find|recall|replay|entity_|graph_|peer_)/.test(slug)) {
    const q = pickString(args, QUERY_KEYS);
    return {
      label: q ? `Searching your brain for “${q}”…` : 'Searching your brain…',
      kind: 'brain',
    };
  }

  // Write / action tools — name the action (and subject) so the trail records
  // what changed, with a glyph that fits the action. Creates get a "Saving
  // “title” <where>…" when the title is safe.
  const kind = actionKind(slug);
  if (/_create$/.test(slug)) {
    const title = pickString(args, TITLE_KEYS);
    if (title) {
      const noun = CREATE_NOUN[slug.split('_')[0] ?? ''];
      return { label: `Saving “${title}”${noun ? ` ${noun}` : ''}…`, kind };
    }
    return { label: ACTION_LABELS[slug] ?? 'Saving that…', kind };
  }
  const specific = ACTION_LABELS[slug];
  if (specific) return { label: specific, kind };

  // Verb fallback for any other tool. The old subject-less forms ("Updating
  // that…", "Working on it…") told the operator nothing — every unmapped tool
  // read identically. Name the tool's noun (slug minus its verb affix,
  // underscores → spaces) and the subject when a safe one is present, so the
  // trail says "Updating table row “Pump P-101”…" instead of "Updating that…".
  const noun = slugNoun(slug);
  const subject = pickString(args, TITLE_KEYS);
  const tail = subject ? `${noun} “${subject}”` : noun;
  if (/(_update$|^update_|_edit$|^edit_|_rename$|_set$)/.test(slug))
    return { label: `Updating ${tail}…`, kind };
  if (/(_add$)/.test(slug)) return { label: `Adding ${tail}…`, kind };
  if (/(_delete$|^delete_|_remove$|^remove_)/.test(slug))
    return { label: `Removing ${tail}…`, kind };
  if (/(_send$|^send_)/.test(slug)) return { label: `Sending ${tail}…`, kind };
  if (/(_read$|_get$|_list$|^read_|^get_|^list_)/.test(slug))
    return { label: `Looking up ${tail}…`, kind };
  return { label: `Using ${slugNoun(slug, { keepVerb: true })}…`, kind: 'tool' };
}

/** Human noun for a tool slug: strip a leading/trailing verb affix, swap
 *  underscores for spaces — `table_rows_add` → "table rows", `page_split` →
 *  "page split" (keepVerb). Always non-empty (falls back to the full slug). */
function slugNoun(slug: string, opts: { keepVerb?: boolean } = {}): string {
  const stripped = opts.keepVerb
    ? slug
    : slug
        .replace(/_(update|edit|rename|set|add|delete|remove|send|read|get|list|create)$/, '')
        .replace(/^(update|edit|delete|remove|send|read|get|list|create)_/, '');
  return (stripped || slug).replace(/_/g, ' ');
}

export function stageLabelForStep(
  name: string,
  input?: Record<string, unknown>,
  /** Accepted for call-site compatibility (the producer passes the step's seq);
   *  no longer used now that the thinking label is a single constant. */
  _seed?: number,
): StageLabel | null {
  if (!name) return null;
  // LLM calls: the adapter step name always ends in `_chat` or `_chat[…]`.
  if (/_chat(\[|$)/.test(name)) return { label: THINKING_LABEL, kind: 'thinking' };

  const tool = /^tool:\s*(.+)$/.exec(name);
  if (tool) return toolStage(tool[1]!.trim(), toolArgs(input));

  if (/^spill_result:/.test(name)) return { label: 'Reading more results…', kind: 'tool' };
  return null;
}
