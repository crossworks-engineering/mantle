/**
 * `ask_human` answer path (slice 3 WP3, docs/runs-slice-3-plan.md §4 + audit
 * amendments). An ask_human item is the audit-item pattern with a human in
 * the LLM's place: promote parks it `ready` (never dispatched) and creates a
 * `pending_tool_calls` row as the approval surface; the human's decision —
 * via `pending_approve` / `pending_reject` — lands here and completes the
 * item, which drives the completion counter like any other terminal
 * transition (the group advances; nothing special downstream).
 *
 * The answer rides `result.answer` into the compiled run state, so later
 * steps and the resume prompt see it verbatim.
 *
 * Owner scoping is enforced HERE against the run row (final audit F2): the
 * pending row is owner-scoped by `approvePendingCall`/`rejectPendingCall`,
 * but the row's ARGS are only trustworthy when the runs engine wrote them —
 * a slug-squatted `ask_human` tool could mint a row whose `item_id` points
 * at someone else's run. The item's run must belong to `ownerId` or the
 * decision refuses.
 */
import { eq } from 'drizzle-orm';
import { runItems, runs, type Db } from '@mantle/db';

import { completeItem, type PostCommitAction } from './engine';

/** One answered sub-question of a structured questionnaire (WP1).
 *  `question` is the form question's id (or its header/text — the answer
 *  surface echoes whatever it rendered). */
export type HumanFormAnswer = {
  question: string;
  selected: string[];
  /** Free text from the "Other" escape, when the options didn't fit. */
  other?: string;
};

const MAX_ANSWER_CHARS = 4_000;

/** The questionnaire as the PLAN authored it, read off the item's own payload
 *  — the authoritative copy. (The pending row's args carry a duplicate for
 *  the UI; it is not trusted for validation.) */
type ItemForm = {
  questions: Array<{
    id?: unknown;
    header?: unknown;
    question?: unknown;
    options?: unknown;
    allow_other?: unknown;
  }>;
};

function readForm(payload: unknown): ItemForm | null {
  if (!payload || typeof payload !== 'object') return null;
  const form = (payload as Record<string, unknown>)['form'];
  if (!form || typeof form !== 'object' || Array.isArray(form)) return null;
  const questions = (form as Record<string, unknown>)['questions'];
  return Array.isArray(questions) ? ({ questions } as ItemForm) : null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The label a question should carry into the prompt: its header, else its
 *  full text. NEVER the bare id — a resumed responder reading
 *  "q1: production" cannot tell which decision that was. */
function questionLabel(q: ItemForm['questions'][number], fallbackId: string): string {
  return str(q.header).trim() || str(q.question).trim() || fallbackId;
}

/**
 * Check submitted answers against the questionnaire the plan authored.
 * Returns a teaching error, or null when the answers are usable.
 *
 * WHY this exists: the answers land in `result.answer`, which is read into
 * the RESUME PROMPT. Without a check, any caller of `pending_approve` could
 * put arbitrary text in front of the responder under the guise of an
 * operator decision, and a genuine typo (a stale question id after a
 * re-plan) would be silently accepted as an answer to a question nobody
 * asked.
 */
function validateAnswers(form: ItemForm, answers: readonly HumanFormAnswer[]): string | null {
  const byId = new Map<string, ItemForm['questions'][number]>();
  form.questions.forEach((q, i) => byId.set(str(q.id).trim() || `q${i + 1}`, q));
  const known = [...byId.keys()];
  const seen = new Set<string>();
  for (const a of answers) {
    const id = a.question?.trim();
    if (!id)
      return `each answer needs a 'question' — the id of the form question it answers (${known.join(', ')})`;
    const q = byId.get(id);
    if (!q) {
      return (
        `'${id}' is not a question on this form — it asks: ${known.join(', ')}. ` +
        `Answer by question id, one entry each.`
      );
    }
    if (seen.has(id)) return `'${id}' was answered twice — send one entry per question`;
    seen.add(id);
    const labels = new Set(
      (Array.isArray(q.options) ? q.options : []).map((o) =>
        typeof o === 'string' ? o : str((o as Record<string, unknown>)?.label),
      ),
    );
    for (const pick of a.selected) {
      if (!labels.has(pick)) {
        return (
          `'${pick}' is not an option for '${id}'` +
          (labels.size > 0 ? ` — choose from: ${[...labels].join(', ')}` : '') +
          (q.allow_other === false ? '' : `, or put free text in 'other'`)
        );
      }
    }
    if (a.other?.trim() && q.allow_other === false) {
      return `'${id}' does not accept free text (allow_other is off) — choose one of its options`;
    }
  }
  return null;
}

/**
 * Flatten structured answers into the one-line-per-question prose that rides
 * `result.answer`. EVERY existing consumer — the compiled state, the resume
 * prompt, later steps reading the answer — keeps working unchanged; the
 * structured array is additive.
 *
 * Pass the item's `form` so each line is headed by the question's HEADER or
 * TEXT rather than its id: the id is a routing key the operator never sees,
 * and "q1: production" tells a resumed responder nothing.
 */
export function renderFormAnswers(
  answers: readonly HumanFormAnswer[],
  form?: { questions: Array<Record<string, unknown>> } | null,
): string {
  const labels = new Map<string, string>();
  (form?.questions ?? []).forEach((q, i) => {
    const id = str(q.id).trim() || `q${i + 1}`;
    labels.set(id, questionLabel(q as ItemForm['questions'][number], id));
  });
  return answers
    .map((a) => {
      const picks = [...a.selected];
      if (a.other?.trim()) picks.push(`Other: ${a.other.trim()}`);
      const label = labels.get(a.question) ?? a.question;
      return `${label}: ${picks.length > 0 ? picks.join(', ') : '(no answer)'}`;
    })
    .join('\n')
    .slice(0, MAX_ANSWER_CHARS);
}

export type HumanAnswerResult =
  | { ok: true; state: 'done' | 'failed'; actions: PostCommitAction[] }
  | {
      ok: false;
      /** 'moved_on': the item is already terminal (cancelled, timed out, or
       *  the run died) — the caller expires the pending row and tells the
       *  operator the run moved on. 'not_ask_human': bad ref. 'forbidden':
       *  the item's run belongs to a different owner — never applied.
       *  'invalid_answers': the answers don't match the questionnaire — the
       *  caller hands the decision BACK so it can be corrected (nothing was
       *  applied; the question is still open). */
      reason: 'moved_on' | 'not_ask_human' | 'forbidden' | 'invalid_answers';
      error: string;
    };

/**
 * Apply a human decision to an ask_human item. 'answered' completes it
 * `done` with the answer (optional for yes/no-shaped questions — approval
 * itself is the answer); 'rejected' completes it `failed({type:'rejected'})`
 * so join policies treat it like any failed step (a fail_fast group stops,
 * wait_all records and continues).
 *
 * CAS-safe: if the item went terminal meanwhile (run cancelled, dated
 * question swept as timeout), returns `moved_on` — the caller must NOT
 * pretend the answer took effect.
 */
export async function applyHumanAnswer(
  db: Db,
  opts: {
    itemId: string;
    ownerId: string;
    decision: 'answered' | 'rejected';
    answer?: string;
    /** Structured questionnaire answers (WP1). When present they also
     *  render into `answer` if the caller didn't supply prose. */
    answers?: readonly HumanFormAnswer[];
  },
): Promise<HumanAnswerResult> {
  const [item] = await db.select().from(runItems).where(eq(runItems.id, opts.itemId));
  if (!item || item.kind !== 'ask_human') {
    return {
      ok: false,
      reason: 'not_ask_human',
      error: `item ${opts.itemId} is not an ask_human item`,
    };
  }
  const [run] = await db
    .select({ ownerId: runs.ownerId })
    .from(runs)
    .where(eq(runs.id, item.runId));
  if (!run || run.ownerId !== opts.ownerId) {
    return {
      ok: false,
      reason: 'forbidden',
      error: `ask_human item ${opts.itemId} does not belong to a run of this owner — decision not applied`,
    };
  }

  const state = opts.decision === 'answered' ? 'done' : 'failed';
  const structured = opts.answers?.length ? opts.answers : undefined;
  // Validate against the ITEM's form — the copy the plan authored, not the
  // pending row's (which a slug-squatted tool could have written). Only for
  // an actual answer: a rejection discards the payload anyway.
  const form = readForm(item.payload);
  if (opts.decision === 'answered' && structured) {
    if (!form) {
      return {
        ok: false,
        reason: 'invalid_answers',
        error: `this question has no questionnaire — send a plain 'answer' string instead of 'answers'`,
      };
    }
    const invalid = validateAnswers(form, structured);
    if (invalid) return { ok: false, reason: 'invalid_answers', error: invalid };
  }
  // Prose answer, in order of preference: what the caller wrote, else the
  // rendered questionnaire, else plain approval (yes/no questions — the
  // approval IS the answer).
  const prose =
    opts.answer?.trim() || (structured ? renderFormAnswers(structured, form) : '') || 'approved';
  const { completed, actions } = await completeItem(db, {
    itemId: item.id,
    state,
    ...(opts.decision === 'answered'
      ? {
          result: {
            answer: prose.slice(0, MAX_ANSWER_CHARS),
            ...(structured ? { answers: structured } : {}),
          },
        }
      : {
          failure: {
            type: 'rejected',
            message: opts.answer?.trim()
              ? `rejected by the operator: ${opts.answer.trim()}`
              : 'rejected by the operator',
            itemId: item.id,
          },
        }),
  });
  if (!completed) {
    return {
      ok: false,
      reason: 'moved_on',
      error:
        `ask_human item ${item.id} is already '${item.state}' — the run moved on ` +
        `(cancelled, timed out, or completed) before this answer; it was not applied`,
    };
  }
  return { ok: true, state, actions };
}
