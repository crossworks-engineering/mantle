/**
 * Scan read check: use `scan_read_check` (docs/decisions.md, section 4).
 * Is a Scan reader's text of a scanned page a faithful reading of the page in
 * the picture? One `noul` question, with the page picture and the text in
 * the state. No local OCR vouches for a book page's read (owner decision
 * 2026-11-19), so this is the one check of its content.
 *
 * Why: on the scan bench (2026-11-19, made-up pages) the OCR engines wrote a
 * whole plausible spec table onto pages too bad to read. Jev told those apart
 * from true reads at 0.5 on 59 of 60 cases, and a read of ANOTHER page with
 * the right line count at 0.02 to 0.13, for about $0.00027 a page.
 *
 * Ships in shadow: the answer lands in the trace and in `used: false`; the
 * caller's free rules (scanReadQualityOf in @mantle/runtime) decide. Live,
 * at or over the use's threshold (0.5 by default) the read is judged
 * faithful, under it not. It never writes, retires or deletes: the worst a
 * wrong answer does is leave a page unread, or keep a read that the free
 * rules would also have kept. Text on the page can steer
 * the answer (rule 6); the picture is the owner's document and leaves the box
 * under the worker's privacy setting, as every state does.
 *
 * Asked by the paid ask of a book page (server/api pipeline-ask.ts) after a
 * Scan reader read the free rules judge good or only `unverified`.
 */
import type { DecisionQuestion } from '@mantle/voice';
import { decide } from './decide';
import { decisionPictureOf, type ShrinkFn } from './picture';

/** The default threshold of a live answer: the probability of "faithful"
 *  at or over which the read is taken. */
export const SCAN_READ_CHECK_THRESHOLD = 0.5;

/** The longest text the check judges. A page's text is a few thousand
 *  characters; past this the check is not asked (the text is never cut: a
 *  cut text would be judged unfaithful for what it left out). */
export const SCAN_READ_CHECK_MAX_CHARS = 30_000;

/** The one question. The model reads literally: say what faithful is and is
 *  not. */
export const SCAN_READ_CHECK_QUESTIONS: Record<string, DecisionQuestion> = {
  faithful: {
    type: 'noul',
    instructions:
      'Is the `transcription` a faithful reading of the page in the picture: the same ' +
      'words, numbers and table rows that are printed on it, with nothing made up?',
    criteria: {
      true: 'every line of the transcription is printed on the page',
      false: 'the transcription holds words, numbers or rows that are not on the page',
    },
  },
};

export type ScanReadCheck = {
  /** The probability that the read is faithful. */
  faithful: number;
  model: string;
  mode: 'shadow' | 'live';
  /** Live, and the answer is used: `faithful` against the threshold. In
   *  shadow always false: the caller's own rule decides. */
  used: boolean;
  /** Live and used: at or over the threshold. */
  passes: boolean;
  threshold: number;
};

/**
 * Ask the decider whether a Scan reader's text is faithful to the page.
 * Null when the use is off, there is no decider, the text is empty or past
 * SCAN_READ_CHECK_MAX_CHARS, the picture cannot be made one Jev reads (the
 * parser could not shrink it), the model takes no picture, or the call
 * failed: the caller keeps its own rule. Never throws for those.
 */
export async function checkScanRead(
  ownerId: string,
  page: { picture: Buffer; mimeType: string; text: string },
  shrink?: ShrinkFn,
): Promise<ScanReadCheck | null> {
  const text = page.text.trim();
  if (!text || text.length > SCAN_READ_CHECK_MAX_CHARS) return null;
  // The parser shrinks a large picture: busy, restarting or slow, that is no
  // answer, never a throw (the check must not cost the caller its read).
  const picture = await decisionPictureOf(page.picture, page.mimeType, shrink).catch(() => null);
  if (!picture) return null;
  const outcome = await decide({
    ownerId,
    use: 'scan_read_check',
    state: ['transcription:\n' + text, picture.part],
    questions: SCAN_READ_CHECK_QUESTIONS,
  });
  const answer = outcome?.answers.faithful;
  if (!outcome || answer?.type !== 'noul') return null;
  const threshold = outcome.use.threshold ?? SCAN_READ_CHECK_THRESHOLD;
  const used = outcome.mode === 'live';
  return {
    faithful: answer.probability,
    model: outcome.model,
    mode: outcome.mode,
    used,
    passes: used && answer.probability >= threshold,
    threshold,
  };
}
