/**
 * Benchmark prompts: how a session becomes a note, how the answer model is
 * asked, and how the judge grades. Pure functions, unit-tested.
 *
 * The judges are the published ones, so a score here means what it means in
 * the papers and leaderboards:
 *  - LoCoMo: Mem0's LLM judge (mem0ai/mem0, evaluation/metrics/llm_judge.py at
 *    commit b3ede5b7, Apache-2.0), the one Mem0, Zep and later LoCoMo
 *    comparisons use.
 *  - LongMemEval: the official per-type answer checks (xiaowu0162/LongMemEval,
 *    src/evaluation/evaluate_qa.py, MIT).
 * The answer prompt is ours: it is part of the system under test.
 */
import type { BenchQuestion, BenchSession, DatasetName } from './datasets';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "Monday 8 May 2023, 1:56 pm UTC", or "an unknown date". Built by hand, not
 *  by Intl, so the text is the same on every Node and ICU build. */
export function formatBenchDate(d: Date | null): string {
  if (!d) return 'an unknown date';
  const h = d.getUTCHours();
  const time = `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${time} UTC`;
}

/**
 * A session as the note the brain ingests. The date goes in the title AND the
 * first body line: the extractor sees only title, type and body (not
 * created_at), and resolves "yesterday" against a date it can read.
 */
export function sessionToNote(
  session: BenchSession,
  index: number,
): { title: string; content: string } {
  const when = formatBenchDate(session.date);
  const lines = session.turns.map((t) => `${t.speaker}: ${t.text}`);
  return {
    title: `${sessionTitleMarker(index)} ${when}`,
    content: [`Conversation held on ${when}.`, '', ...lines].join('\n'),
  };
}

/** The start of a session note's title: "Conversation 3,". The comma keeps
 *  "Conversation 1," from matching inside "Conversation 11,". */
export function sessionTitleMarker(index: number): string {
  return `Conversation ${index + 1},`;
}

/**
 * How many of the evidence sessions reached the context (pure): a session
 * counts when its note's title appears, which happens for content hits and
 * passages. Pass the context WITHOUT the corpus map, which lists every title.
 * Facts carry no title, so a session that arrived only as facts is not
 * counted: this is a lower bound on what the model saw.
 */
export function evidenceFound(context: string, evidence: readonly number[]): number {
  return evidence.filter((i) => context.includes(sessionTitleMarker(i))).length;
}

/** Did the answer say the memory lacks it? Separates "retrieved nothing
 *  useful" from "answered wrong" among the misses (pure, heuristic). */
export function saidMissing(answer: string): boolean {
  return /\b(does not|doesn't|did not|didn't) (contain|mention|include|say|state|specify)|\bno (information|mention|record)\b|\bnot (mentioned|stated|specified|available|provided)\b|\b(can(no|')t|unable to) (be )?(determine|answer|find)|\bnot enough information\b/i.test(
    answer,
  );
}

/**
 * The answer prompt around the brain's retrieved context. `context` is the
 * exact text the responder would get for this question (see context.ts).
 */
/**
 * `strict` (runs A and A2): the model must say so when the memory does not
 * state the answer. It refused most inference questions ("would she...?"):
 * 76% of the wrong open-domain answers in run A. `infer` (the default since
 * then) lets it reason from what the memory does say, and keeps "not in the
 * memory" for when nothing bears on the question at all.
 */
export type AnswerStyle = 'strict' | 'infer';

const MISSING_RULE: Record<AnswerStyle, string[]> = {
  strict: ['If the memory does not contain the answer, say so plainly instead of guessing.'],
  infer: [
    'If the memory does not state the answer outright, reason from what it does say (what',
    'someone did, planned, liked or said about themselves) and give the best supported answer,',
    'noting that it is inferred. Say the memory lacks the answer only when nothing in it bears',
    'on the question.',
  ],
};

export function answerPrompt(
  q: BenchQuestion,
  context: string,
  style: AnswerStyle = 'infer',
): { system: string; user: string } {
  const system = [
    'You answer questions about past conversations, using only the memory context below.',
    `The question is being asked on ${formatBenchDate(q.askedAt)}.`,
    'Each conversation note carries the date it was held. Turn relative times ("yesterday",',
    '"last week") into dates using that date, and answer time questions with a date or period.',
    'When the memory holds an older and a newer value, the newer one is current.',
    'For "how many" questions, list each item you count before giving the total.',
    ...MISSING_RULE[style],
    'End with one line that starts with "Answer:" and gives the short final answer.',
    '',
    '# Memory context',
    context || '(nothing was retrieved)',
  ].join('\n');
  return { system, user: q.question };
}

/** The short final answer, from the "Answer:" line when there is one. */
export function extractFinalAnswer(text: string): string {
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // Bold markers may wrap the label ("**Answer:** Rome"): drop them first.
    const m = /^\s*answer\s*:\s*(.+)$/i.exec(lines[i]!.replace(/\*/g, ''));
    if (m) return m[1]!.trim();
  }
  return text.trim();
}

const LOCOMO_JUDGE = `
Your task is to label an answer to a question as ’CORRECT’ or ’WRONG’. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a ’gold’ (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: {question}
Gold answer: {gold_answer}
Generated answer: {generated_answer}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Just return the label CORRECT or WRONG in a json format with the key as "label".
`;

const LME_STANDARD =
  'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.';
const LME_TEMPORAL = `${LME_STANDARD} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct.`;
const LME_UPDATE =
  'I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.';
const LME_PREFERENCE =
  "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.";
const LME_ABSTENTION =
  'I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.';

/** The judge prompt for one graded answer (the full response, not just the final line). */
export function judgePrompt(dataset: DatasetName, q: BenchQuestion, response: string): string {
  if (dataset === 'locomo') {
    return LOCOMO_JUDGE.replace('{question}', q.question)
      .replace('{gold_answer}', q.answer)
      .replace('{generated_answer}', response);
  }
  if (q.abstention) {
    return `${LME_ABSTENTION}\n\nQuestion: ${q.question}\n\nExplanation: ${q.answer}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`;
  }
  const head =
    q.category === 'temporal-reasoning'
      ? LME_TEMPORAL
      : q.category === 'knowledge-update'
        ? LME_UPDATE
        : q.category === 'single-session-preference'
          ? LME_PREFERENCE
          : LME_STANDARD;
  const goldLabel = q.category === 'single-session-preference' ? 'Rubric' : 'Correct Answer';
  return `${head} \n\nQuestion: ${q.question}\n\n${goldLabel}: ${q.answer}\n\nModel Response: ${response}\n\nIs the model response correct? Answer yes or no only.`;
}

/** The judge's verdict: true / false, or null when it gave neither. */
export function parseVerdict(dataset: DatasetName, text: string): boolean | null {
  if (dataset === 'locomo') {
    const label = /"label"\s*:\s*"?\s*(CORRECT|WRONG)/i.exec(text)?.[1];
    if (label) return label.toUpperCase() === 'CORRECT';
    const hasC = /\bCORRECT\b/.test(text);
    const hasW = /\bWRONG\b/.test(text);
    return hasC === hasW ? null : hasC;
  }
  const m = /\b(yes|no)\b/i.exec(text.trim());
  return m ? m[1]!.toLowerCase() === 'yes' : null;
}
