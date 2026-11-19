/**
 * The Translator's pure parts: how long a part may be on a given model, how
 * a text is cut into parts, the prompt one part is sent with, and the loop
 * that translates every part in order. No database and no provider here:
 * the model call is passed in, so each rule is tested on its own
 * (translate-parts.test.ts).
 *
 * The standing rule (owner, 2026-11-19): everything is consumed in full.
 * So the cut is exact (the parts joined are the text, byte for byte), every
 * part is translated, an answer the model cut short is cut in two and done
 * again, and a part that still fails stops the whole call with an error.
 * Nothing here ever returns a shortened text.
 */
import { backgroundFence, withFenceNote, type Fence } from '@mantle/std';

/** Target tokens per source token in a bad case (English into a script the
 *  tokenizer splits finely). A part is sized so its answer fits the model's
 *  output limit even then. */
export const TRANSLATE_EXPANSION = 2.5;
/** Tokens kept for the system prompt, the fence and the ask. */
export const TRANSLATE_PROMPT_TOKENS = 2_000;
/** The output limit assumed when the catalog gives none: a careful one that
 *  every current chat model meets. */
export const TRANSLATE_UNKNOWN_OUTPUT_TOKENS = 8_192;
/** The context window assumed when the catalog gives none (a local or a
 *  direct model with no OpenRouter id): a careful one, so a server that
 *  trims a long prompt by itself never gets a part it would trim. */
export const TRANSLATE_UNKNOWN_CONTEXT_TOKENS = 8_192;
/** The smallest part, whatever the model says. */
export const TRANSLATE_MIN_PART_TOKENS = 256;
/** Tries per part for an error, an empty answer or a refusal. */
export const TRANSLATE_TRIES = 3;
/** How many times a part whose answer hit the output limit is halved. */
export const TRANSLATE_MAX_HALVINGS = 4;
/** Parts in flight at once. The answer is joined in the text's order. */
export const TRANSLATE_CONCURRENCY = 3;

/** A model's limits as the catalog reports them (null: unknown). */
export type ModelLimits = { context: number | null; output: number | null };

/** What one part may hold on this model, and the answer budget per call. */
export type PartBudget = {
  /** Source tokens (estimated) per part. */
  partTokens: number;
  /** The `maxTokens` each call asks for. */
  maxOutputTokens: number;
};

/**
 * The part budget for a model, from its context window and output limit:
 * a part's answer (its tokens times TRANSLATE_EXPANSION) fits the output
 * limit, and the part plus the prompt plus the answer fit the window. An
 * operator may ask for smaller parts (the worker's `params.part_tokens`),
 * never for larger ones than the model holds.
 */
export function partBudgetFor(
  limits: ModelLimits,
  partTokensParam?: number | null,
  /** Tokens of the worker's own instructions, sent with every part. */
  extraPromptTokens = 0,
): PartBudget {
  const context =
    limits.context && limits.context > 0 ? limits.context : TRANSLATE_UNKNOWN_CONTEXT_TOKENS;
  let output = limits.output && limits.output > 0 ? limits.output : TRANSLATE_UNKNOWN_OUTPUT_TOKENS;
  // A catalog that gives the window as the output limit: the answer may not
  // take the whole window, the part needs room too.
  output = Math.min(output, Math.floor(context / 2));
  const byOutput = Math.floor((output * 0.9) / TRANSLATE_EXPANSION);
  const byContext = context - output - TRANSLATE_PROMPT_TOKENS - Math.max(0, extraPromptTokens);
  let partTokens = Math.min(byOutput, byContext);
  if (partTokensParam && partTokensParam > 0) partTokens = Math.min(partTokens, partTokensParam);
  partTokens = Math.max(TRANSLATE_MIN_PART_TOKENS, Math.floor(partTokens));
  return { partTokens, maxOutputTokens: Math.max(output, TRANSLATE_MIN_PART_TOKENS) };
}

/**
 * Tokens of a text, estimated on the high side: four ASCII characters to a
 * token, and every other character a token of its own (CJK, Cyrillic,
 * accented letters, emoji halves). High is the safe side: a part that is
 * estimated too large is only a smaller part.
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) tokens += charTokens(text.charCodeAt(i));
  return Math.ceil(tokens);
}

const HEADING = /^#{1,6}\s/;

/** The run a line opens a fenced code block with (CommonMark: up to three
 *  spaces, three or more backticks or tildes; a backtick run's info string
 *  holds no backtick), or null. */
function fenceOpens(line: string): string | null {
  const m = line.replace(/\r?\n$/, '').match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!m) return null;
  if (m[1]![0] === '`' && m[2]!.includes('`')) return null;
  return m[1]!;
}

/** Whether a line closes the fence `run` opened: the same character, at
 *  least as many, and nothing else on the line. */
function fenceCloses(line: string, run: string): boolean {
  const m = line.replace(/\r?\n$/, '').match(/^ {0,3}(`{3,}|~{3,})\s*$/);
  return !!m && m[1]![0] === run[0] && m[1]!.length >= run.length;
}

/** The fenced code blocks of `lines`, by first and last line. A fence that
 *  never closes is no code block: its lines stay text (a separator line of
 *  tildes, an unclosed fence), so they are translated, never skipped. */
function fenceSpans(lines: readonly string[]): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const run = fenceOpens(lines[i]!);
    if (!run) continue;
    let j = i + 1;
    while (j < lines.length && !fenceCloses(lines[j]!, run)) j++;
    if (j < lines.length) {
      spans.push({ start: i, end: j });
      i = j;
    }
  }
  return spans;
}

/**
 * The text's blocks, exactly: a run of lines with text, with the blank
 * lines after it. A closed fenced code block is always a block of its own
 * (its blank lines included), whatever is written right before or after
 * it. The blocks joined are the text.
 */
export function blocksOf(text: string): string[] {
  const lines = text ? linesOf(text) : [];
  const spans = new Map(fenceSpans(lines).map((s) => [s.start, s.end]));
  const blocks: string[] = [];
  let cur = '';
  let trailingBlank = false;
  let afterFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const end = spans.get(i);
    if (end !== undefined) {
      if (cur.trim() !== '') {
        blocks.push(cur);
        cur = '';
      }
      cur += lines.slice(i, end + 1).join('');
      i = end;
      trailingBlank = false;
      afterFence = true;
      continue;
    }
    if (line.trim() === '') {
      cur += line;
      trailingBlank = cur.trim() !== '';
      continue;
    }
    // A line with text after blank lines or after a fence starts a block.
    if (cur.trim() !== '' && (trailingBlank || afterFence)) {
      blocks.push(cur);
      cur = '';
    }
    trailingBlank = false;
    afterFence = false;
    cur += line;
  }
  if (cur) blocks.push(cur);
  return blocks;
}

/** Whether a block is a closed fenced code block (with blank lines around
 *  it only). */
export function isFenceBlock(block: string): boolean {
  const lines = linesOf(block.trimStart());
  const first = fenceSpans(lines)[0];
  if (!first || first.start !== 0) return false;
  return lines.slice(first.end + 1).every((l) => l.trim() === '');
}

/** Tokens of a text counted on the LOW side (six ASCII characters or eight
 *  others to a token): what any tokenizer reads at least. */
export function lowTokens(text: string): number {
  let ascii = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) < 128) ascii++;
  return Math.floor(ascii / 6 + (text.length - ascii) / 8);
}

/** One character's share of {@link estimateTokens}. */
const charTokens = (code: number) => (code < 128 ? 0.25 : 1);

/** Units packed into pieces of at most `max` tokens; a unit too large on
 *  its own goes to `tooBig`. Exact: the pieces joined are the units. */
function packUnits(units: string[], max: number, tooBig: (u: string) => string[]): string[] {
  const out: string[] = [];
  let cur = '';
  let curTokens = 0;
  for (const u of units) {
    const t = estimateTokens(u);
    if (t > max) {
      if (cur) out.push(cur);
      cur = '';
      curTokens = 0;
      out.push(...tooBig(u));
      continue;
    }
    if (cur && curTokens + t > max) {
      out.push(cur);
      cur = '';
      curTokens = 0;
    }
    cur += u;
    curTokens += t;
  }
  if (cur) out.push(cur);
  return out;
}

/** A text cut anywhere into pieces of at most `max` tokens, never inside a
 *  surrogate pair. */
function hardCut(text: string, max: number): string[] {
  const out: string[] = [];
  let start = 0;
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // The low half of a pair stays with its high half.
    if (code >= 0xdc00 && code <= 0xdfff && i > start) {
      tokens += charTokens(code);
      continue;
    }
    if (i > start && tokens + charTokens(code) > max) {
      out.push(text.slice(start, i));
      start = i;
      tokens = 0;
    }
    tokens += charTokens(code);
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [text];

/** A line's sentences, exactly (the end mark and the spaces after it stay
 *  with the sentence). */
function sentencesOf(line: string): string[] {
  const parts = line.match(/[^.!?\u3002\uff01\uff1f]+[.!?\u3002\uff01\uff1f]*\s*|.+$/gs) ?? [];
  return parts.join('') === line ? parts : [line];
}

/** Cut one piece of text that is too long into pieces of at most `max`
 *  tokens: at line ends, then at sentence ends, then anywhere. Exact: the
 *  pieces joined are the text. */
function cutLong(text: string, max: number): string[] {
  return packUnits(linesOf(text), max, (line) =>
    packUnits(sentencesOf(line), max, (sentence) => hardCut(sentence, max)),
  );
}

/**
 * The text cut into parts of at most `maxTokens` (estimated) each, at
 * block ends (paragraphs, whole tables, whole code blocks), a part starting
 * at a heading where it can. A block longer than a part is cut at line
 * ends, then sentence ends. Exact: the parts joined are the text.
 */
export function splitForTranslation(text: string, maxTokens: number): string[] {
  const max = Math.max(1, maxTokens);
  const parts: string[] = [];
  let cur = '';
  let curSize = 0;
  for (const block of blocksOf(text)) {
    const size = estimateTokens(block);
    if (size > max) {
      if (cur) parts.push(cur);
      cur = '';
      curSize = 0;
      // Code is never sent to the model (maskCode): a long code block is a
      // part of its own, whole, never cut.
      parts.push(...(isFenceBlock(block) ? [block] : cutLong(block, max)));
      continue;
    }
    const full = cur && curSize + size > max;
    // A heading opens a part when the current one is well filled.
    const heading = cur && HEADING.test(block) && curSize >= max * 0.6;
    if (full || heading) {
      parts.push(cur);
      cur = '';
      curSize = 0;
    }
    cur += block;
    curSize += size;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** The whitespace around a part, kept as it is (only the words go to the
 *  model). */
export function framePart(part: string): { lead: string; body: string; tail: string } {
  const lead = part.match(/^\s*/)![0];
  const rest = part.slice(lead.length);
  const tail = rest.match(/\s*$/)![0];
  return { lead, body: rest.slice(0, rest.length - tail.length), tail };
}

/** A fenced code block's stand-in in what the model is sent: the code is
 *  never sent, so it cannot be translated (a live check, 2026-11-19, found
 *  a model translating a string inside a shell block), and is put back
 *  byte for byte. The stand-in carries a per-call nonce, so a source that
 *  happens to hold one is never mistaken for it. */
const CODE_MARK = (nonce: string, n: number) => `@@CODE-${nonce}-${n}@@`;

/** The body with each fenced code block replaced by its stand-in. */
export function maskCode(
  body: string,
  // Digits only: a model that changes the case of a line keeps it.
  nonce: string = String(Math.floor(1e7 + Math.random() * 9e7)),
): { masked: string; blocks: string[]; nonce: string } {
  const blocks: string[] = [];
  const masked = blocksOf(body)
    .map((block) => {
      if (!isFenceBlock(block)) return block;
      // Only the blank lines before it: a fence line's own indent stays in
      // the code, so it comes back as it was.
      const lead = block.match(/^(?:[ \t]*\r?\n)*/)![0];
      const rest = block.slice(lead.length);
      const tail = rest.match(/\s*$/)![0];
      blocks.push(rest.slice(0, rest.length - tail.length));
      return `${lead}${CODE_MARK(nonce, blocks.length)}${tail}`;
    })
    .join('');
  return { masked, blocks, nonce };
}

/** The answer with the code put back, or null when a stand-in is missing,
 *  repeated or unknown (the answer is then not taken). */
export function unmaskCode(
  answer: string,
  blocks: readonly string[],
  nonce: string,
): string | null {
  const re = new RegExp(`@@CODE-${nonce}-(\\d+)@@`, 'g');
  const seen = new Map<number, number>();
  for (const m of answer.matchAll(re)) {
    const n = Number(m[1]);
    seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  if (seen.size !== blocks.length) return null;
  for (let n = 1; n <= blocks.length; n++) if (seen.get(n) !== 1) return null;
  return answer.replace(re, (_, n: string) => blocks[Number(n) - 1]!);
}

/** The rules every part is translated by. */
export const TRANSLATE_RULES = [
  'You are a professional translator. Translate the text you are given and output ONLY the translation: no preamble, no notes, no closing remarks, no quotation marks around it.',
  'Translate every sentence. Never summarize, shorten, skip, merge or add content.',
  'Keep the layout exactly: Markdown headings, lists, tables (same rows and columns), block quotes, line breaks and blank lines.',
  'A line like @@CODE-x1y2-1@@ stands for a code block: keep every such line exactly as it is, once, in its place.',
  'Do not translate code: code blocks, inline code, commands, file paths, URLs, link targets, image paths, e-mail addresses, ids and markup (HTML tags, anything in curly braces, `media:` lines) stay exactly as they are. Translate only the visible text of a link.',
  'Keep numbers, dates, units, currency amounts, product names and the names of people, companies and places as they are (use a name’s usual form in the target language only where one is well established).',
  'If a part is already in the target language, output it unchanged.',
].join('\n');

/** The system prompt and the user message for one part. Pure, so the
 *  prompt is pinned (translate-parts.test.ts). */
export function buildTranslateInput(opts: {
  to: string;
  from?: string | null;
  body: string;
  part: number;
  parts: number;
  /** The worker's own system prompt: extra instructions after the rules
   *  (never instead of them). */
  extra?: string | null;
  fence?: Fence;
}): { system: string; user: string } {
  const fence = opts.fence ?? backgroundFence();
  const extra = opts.extra?.trim();
  const system = withFenceNote(
    extra ? `${TRANSLATE_RULES}\n\nAdditional instructions:\n${extra}` : TRANSLATE_RULES,
    fence,
  );
  const from = opts.from?.trim() ? ` from the language "${opts.from.trim()}"` : '';
  const where =
    opts.parts > 1
      ? ` This is part ${opts.part} of ${opts.parts} of one document: translate this part only, it may start or end mid-section.`
      : '';
  // The languages are names, quoted: never instructions.
  const user = `Translate the text below${from} into the language "${opts.to}".${where}\n\n${fence.wrap(opts.body)}`;
  return { system, user };
}

/** Take the fence's markers off an answer that echoed them. */
export function cleanAnswer(text: string, fence: Fence): string {
  return text
    .split('\n')
    .filter((l) => l.trim() !== fence.open && l.trim() !== fence.close)
    .join('\n')
    .trim();
}

/** One model answer, as the loop needs it. */
export type PartAnswer = {
  text: string;
  /** Only 'stop' is a finished answer. 'length': cut at the output limit.
   *  Anything else, none included, is not taken (a stream that closed
   *  early ends with no finish). */
  finishReason?: string;
  /** The prompt tokens the provider reports it read, when it says. */
  tokensIn?: number;
};

/** Raised when a part cannot be translated in full: the call fails. */
export class TranslatePartError extends Error {
  constructor(
    readonly part: number,
    readonly parts: number,
    readonly reason: string,
    readonly done: number,
  ) {
    super(
      `Translation stopped: part ${part} of ${parts} could not be translated (${reason}). ` +
        `${done} of ${parts} parts were done. Nothing was saved and no shortened text is returned; try again, or pick another translator model.`,
    );
    this.name = 'TranslatePartError';
  }
}

/** Why an answer is not a translation of its part, or null when it is. */
function answerProblem(
  source: string,
  answer: PartAnswer,
  clean: string,
  sentTokens: number,
): string | null {
  if (answer.finishReason === 'content_filter') return 'the provider refused it';
  if (answer.finishReason === 'error') return 'the provider sent a broken answer';
  if (answer.finishReason !== 'stop') return 'the answer ended without a finish';
  if (!clean) return 'the answer was empty';
  // A server that trimmed the prompt by itself read far less than was sent.
  // `sentTokens` is a low-side count, so a tokenizer that packs a script
  // tightly is never refused; only a large gap counts.
  if (answer.tokensIn !== undefined && answer.tokensIn > 0 && answer.tokensIn < sentTokens * 0.5) {
    return 'the model read only part of the text';
  }
  // A long part answered with a few lines is a summary, not a translation.
  if (source.length > 2_000 && clean.length < source.length * 0.1) {
    return 'the answer was far shorter than the text';
  }
  return null;
}

/** A model a part may go to, with the answer budget it is asked for. */
export type ModelRoute = { model: string; maxOutputTokens: number };

/** The model call: one part's prompt to one model. It throws the fixed
 *  sentence for a provider error (never the provider's own body). */
export type PartCall = (route: ModelRoute, system: string, user: string) => Promise<PartAnswer>;

/**
 * Translate one part. The primary model first; when it fails the part (an
 * error, a refusal, an empty or far too short answer, or one cut at the
 * output limit) the fallback model, then the primary again, up to
 * TRANSLATE_TRIES calls: never a second pass over an answer that was good.
 * An answer cut at the output limit by every model tried cuts the part in
 * two, and each half is done on its own.
 */
async function translateOnePart(opts: {
  body: string;
  index: number;
  total: number;
  primary: ModelRoute;
  fallback: ModelRoute | null;
  call: PartCall;
  prompt: (body: string) => { system: string; user: string; fence: Fence };
  depth: number;
  done: () => number;
  onFallback: () => void;
  /** True once another part has failed: no further call is made. */
  cancelled: () => boolean;
  /** Why the call must stop now (a budget run out), or null. */
  stopReason: () => string | null;
}): Promise<string> {
  let lastReason = 'no answer';
  let cutShort = 0;
  const stopped = () =>
    new TranslatePartError(opts.index, opts.total, 'another part failed first', opts.done());
  // A part that is only code: nothing to translate, no call.
  const probe = maskCode(opts.body);
  if (!probe.masked.replace(/@@CODE-[a-z0-9]+-\d+@@/g, '').trim()) return opts.body;
  for (let attempt = 1; attempt <= TRANSLATE_TRIES; attempt++) {
    if (opts.cancelled()) throw stopped();
    const stop = opts.stopReason();
    if (stop) throw new TranslatePartError(opts.index, opts.total, stop, opts.done());
    const onFallback = opts.fallback !== null && attempt % 2 === 0;
    const route = onFallback ? opts.fallback! : opts.primary;
    const { masked, blocks, nonce } = maskCode(opts.body);
    const { system, user, fence } = opts.prompt(masked);
    let answer: PartAnswer;
    try {
      answer = await opts.call(route, system, user);
    } catch (err) {
      lastReason = err instanceof Error && err.message ? err.message : 'the provider call failed';
      continue;
    }
    if (answer.finishReason === 'length') {
      cutShort++;
      // The fallback gets its turn first; cut short by every model: halve.
      if (opts.fallback && cutShort < 2 && attempt < TRANSLATE_TRIES) {
        lastReason = 'the answer hit the model\u2019s output limit';
        continue;
      }
      const halves = halve(opts.body);
      if (!halves || opts.depth >= TRANSLATE_MAX_HALVINGS) {
        throw new TranslatePartError(
          opts.index,
          opts.total,
          'the answer hit the model\u2019s output limit and the part cannot be cut smaller',
          opts.done(),
        );
      }
      const out: string[] = [];
      for (const half of halves) {
        if (opts.cancelled()) throw stopped();
        const { lead, body, tail } = framePart(half);
        out.push(lead + (await translateOnePart({ ...opts, body, depth: opts.depth + 1 })) + tail);
      }
      return out.join('');
    }
    const clean = cleanAnswer(answer.text, fence);
    const restored = unmaskCode(clean, blocks, nonce);
    const problem =
      answerProblem(masked, answer, clean, lowTokens(system) + lowTokens(user)) ??
      (restored === null ? 'the answer lost or repeated a code block' : null);
    if (!problem && restored !== null) {
      if (onFallback) opts.onFallback();
      return restored;
    }
    lastReason = problem ?? 'the answer lost a code block';
  }
  throw new TranslatePartError(
    opts.index,
    opts.total,
    `${lastReason}, after ${TRANSLATE_TRIES} tries`,
    opts.done(),
  );
}

/** A part cut in two at its middle block, line or sentence; null when it
 *  cannot be cut. Exact. */
export function halve(text: string): [string, string] | null {
  const target = Math.max(1, Math.floor(estimateTokens(text) / 2));
  const pieces = splitForTranslation(text, target);
  if (pieces.length < 2) return null;
  let best = 1;
  let bestGap = Infinity;
  let acc = 0;
  const half = estimateTokens(text) / 2;
  for (let i = 1; i < pieces.length; i++) {
    acc += estimateTokens(pieces[i - 1]!);
    const gap = Math.abs(acc - half);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return [pieces.slice(0, best).join(''), pieces.slice(best).join('')];
}

/**
 * Translate a whole text: cut into parts of `partTokens` (the primary
 * model's budget), each part translated (TRANSLATE_CONCURRENCY at a time)
 * and the answers joined in the text's order, its whitespace kept. Throws
 * TranslatePartError when a part fails; then no new part is started.
 */
export async function translateInParts(opts: {
  text: string;
  to: string;
  from?: string | null;
  extra?: string | null;
  partTokens: number;
  primary: ModelRoute;
  fallback?: ModelRoute | null;
  call: PartCall;
  onPart?: (done: number, total: number) => void;
  /** Why to stop before the next call (a budget run out), or null. */
  stopReason?: () => string | null;
  /** Parts in flight at once (TRANSLATE_CONCURRENCY when unset; 1 while a
   *  budget applies, so no call runs past it). */
  concurrency?: number;
}): Promise<{ text: string; parts: number; fallbackParts: number }> {
  const parts = splitForTranslation(opts.text, opts.partTokens);
  const total = parts.length;
  const results: string[] = new Array<string>(total);
  let done = 0;
  let fallbackParts = 0;
  let next = 0;
  let failed: unknown = null;
  const worker = async () => {
    while (failed === null && next < total) {
      const i = next++;
      const { lead, body, tail } = framePart(parts[i]!);
      if (!body) {
        results[i] = parts[i]!;
      } else {
        try {
          const translated = await translateOnePart({
            body,
            index: i + 1,
            total,
            primary: opts.primary,
            fallback: opts.fallback ?? null,
            call: opts.call,
            prompt: (b) => {
              const fence = backgroundFence();
              return {
                ...buildTranslateInput({
                  to: opts.to,
                  from: opts.from,
                  body: b,
                  part: i + 1,
                  parts: total,
                  extra: opts.extra,
                  fence,
                }),
                fence,
              };
            },
            depth: 0,
            done: () => done,
            onFallback: () => {
              fallbackParts++;
            },
            cancelled: () => failed !== null,
            stopReason: opts.stopReason ?? (() => null),
          });
          results[i] = lead + translated + tail;
        } catch (err) {
          if (failed === null) failed = err;
          return;
        }
      }
      done++;
      opts.onPart?.(done, total);
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          Math.max(1, opts.concurrency ?? TRANSLATE_CONCURRENCY),
          Math.max(1, total),
        ),
      },
      () => worker(),
    ),
  );
  if (failed !== null) throw failed;
  return { text: results.join(''), parts: total, fallbackParts };
}
