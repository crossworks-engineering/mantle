/**
 * Shared shapes for operator-answerable approval rows.
 *
 * A runner `ask_human` gate and a `run_budget` pause are both ordinary
 * `pending_tool_calls` rows — the engine writes everything the UI needs into
 * `args`, so /pending, the assistant panel and the toast watcher all render
 * from the SAME row without asking the run engine anything.
 */

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

/** Structured questionnaire, as authored in the run plan and copied verbatim
 *  onto the pending row (`args.form`). Mirrors `AskHumanForm` in
 *  @mantle/tools — duplicated rather than imported because this is client
 *  code and the server package pulls in the database. */
export type FormOption = { label: string; description?: string };
export type FormQuestion = {
  id: string;
  header?: string;
  question: string;
  options: FormOption[];
  multi_select?: boolean;
  allow_other?: boolean;
};
export type AskForm = { questions: FormQuestion[] };

/** One answered sub-question, as sent to PATCH /api/pending/:id. */
export type FormAnswer = { question: string; selected: string[]; other?: string };

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
  for (let i = 0; i < rawQuestions.length; i += 1) {
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
    questions.push({
      id: str(o.id) ?? `q${i + 1}`,
      ...(str(o.header) ? { header: str(o.header)! } : {}),
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
