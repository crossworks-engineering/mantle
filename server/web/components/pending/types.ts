/**
 * Shared shapes for operator-answerable approval rows.
 *
 * A runner `ask_human` gate and a `run_budget` pause are both ordinary
 * `pending_tool_calls` rows — the engine writes everything the UI needs into
 * `args`, so /pending, the assistant panel and the toast watcher all render
 * from the SAME row without asking the run engine anything.
 */
import {
  ASK_HUMAN_FORM_LIMITS,
  type AskHumanForm,
  type AskHumanFormAnswer,
  type AskHumanFormOption,
  type AskHumanFormQuestion,
} from '@mantle/client-types';

export type PendingRow = {
  id: string;
  toolSlug: string;
  args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  agentId: string | null;
  traceId: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
};

/** The questionnaire contract — types AND caps — comes from
 *  @mantle/client-types, the dependency-free package the SERVER parser and
 *  answer path validate against too. Re-exported under the local names this
 *  UI already uses. Single-sourcing it is what stops the renderer and the
 *  parser disagreeing about what a valid form is. */
export type FormOption = AskHumanFormOption;
export type FormQuestion = AskHumanFormQuestion;
export type AskForm = AskHumanForm;
export type FormAnswer = AskHumanFormAnswer;
export { ASK_HUMAN_FORM_LIMITS };

/** A decision, optionally carrying a free-text answer and/or structured
 *  questionnaire answers (`ask_human`). */
export type Decide = (
  id: string,
  decision: 'approve' | 'reject',
  payload?: { answer?: string; answers?: FormAnswer[] },
) => Promise<void>;

export const ASK_HUMAN_SLUG = 'ask_human';
export const RUN_BUDGET_SLUG = 'run_budget';

/** Rows a human is expected to ANSWER (as opposed to plain tool approvals). */
export function isQuestionRow(row: PendingRow): boolean {
  return row.toolSlug === ASK_HUMAN_SLUG || row.toolSlug === RUN_BUDGET_SLUG;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

export function stringOptions(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((o): o is string => typeof o === 'string' && o.length > 0)
    : [];
}

/**
 * Read `args.form` defensively. The row is written by the engine, but it is
 * still JSON from a model-authored plan — a malformed form must degrade to
 * "no form" (the flat options / free-text path still answers the question),
 * never throw inside a render.
 */
export function parseForm(v: unknown): AskForm | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const rawQuestions = (v as Record<string, unknown>).questions;
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;
  const questions: FormQuestion[] = [];
  // Honour the SAME cap the API enforces on submission: rendering a
  // 5-question form the route will reject with a 400 wastes the operator's
  // time and gives them no way to succeed.
  for (let i = 0; i < Math.min(rawQuestions.length, ASK_HUMAN_FORM_LIMITS.maxQuestions); i += 1) {
    const q = rawQuestions[i];
    if (!q || typeof q !== 'object' || Array.isArray(q)) continue;
    const o = q as Record<string, unknown>;
    const question = str(o.question);
    if (!question) continue;
    const options: FormOption[] = Array.isArray(o.options)
      ? o.options
          .map((opt) => {
            if (typeof opt === 'string') return { label: opt };
            if (!opt || typeof opt !== 'object' || Array.isArray(opt)) return null;
            const label = str((opt as Record<string, unknown>).label);
            if (!label) return null;
            const description = str((opt as Record<string, unknown>).description);
            return { label, ...(description ? { description } : {}) };
          })
          .filter((x): x is FormOption => x !== null)
      : [];
    const header = str(o.header);
    questions.push({
      // Mirror the SERVER's fallback exactly (explicit id → slugified header
      // → positional). The answer is submitted under this id, so a client
      // that derived it differently would answer a question the engine
      // cannot match.
      id: str(o.id) ?? (header ? header.toLowerCase().replace(/[^a-z0-9]+/g, '-') : `q${i + 1}`),
      ...(header ? { header } : {}),
      question,
      options,
      ...(o.multi_select === true ? { multi_select: true } : {}),
      // Absent means allowed: the parser defaults it on, and a form that
      // reached us from an older plan should still be answerable.
      allow_other: o.allow_other !== false,
    });
  }
  return questions.length > 0 ? { questions } : null;
}

/** Short preview of what a row is asking — toast copy, strip labels. */
export function questionPreview(row: PendingRow, max = 90): string {
  const q =
    str(row.args?.['question']) ??
    (row.toolSlug === RUN_BUDGET_SLUG
      ? 'A run is paused on its budget.'
      : 'A run needs an answer.');
  const oneLine = q.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * "3m ago" for a queued-at timestamp. Shared by every pending surface: it was
 * duplicated in the card and on /pending with *different* behaviour past 24h,
 * so the same row read differently depending on where you looked.
 * Deliberately coarse — it does not tick, and nothing here needs it to.
 */
export function fmtRelative(iso: string): string {
  const secs = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(iso).toLocaleDateString('en-GB');
}
