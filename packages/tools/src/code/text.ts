/**
 * The code tools' text work, pure: numbered views, exact-match edits that
 * apply all or none, line inserts, a unified diff and the file filter. No
 * store, no access: the gateway (tools.ts) reads a target's tree, hands the
 * text here, and writes back what comes out. Regex search runs elsewhere
 * (search.ts), off the main thread.
 */

/** Lines of a text, and whether it ended in a newline. `''` is no lines. */
export function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === '') return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split('\n'), trailingNewline };
}

function joinLines(lines: readonly string[], trailingNewline: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

/** The 1-based line each offset of `text` sits on, for a list of offsets. */
function lineNumbersOf(text: string, offsets: readonly number[]): number[] {
  const out: number[] = [];
  let line = 1;
  let at = 0;
  for (const off of [...offsets].sort((a, b) => a - b)) {
    for (; at < off; at++) if (text.charCodeAt(at) === 10) line++;
    out.push(line);
  }
  return out;
}

/** The start offsets of `needle` in `text`, overlapping ones too (`aa` in
 *  `aaa` is two places, so it is not "once"), at most `limit` of them. */
function offsetsOf(text: string, needle: string, limit: number): number[] {
  const out: number[] = [];
  for (
    let i = text.indexOf(needle);
    i !== -1 && out.length < limit;
    i = text.indexOf(needle, i + 1)
  ) {
    out.push(i);
  }
  return out;
}

/** How many times `needle` is replaced from the left without overlap. */
function replaceCount(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** The match-once places reported at most (one more says "more"). */
const HITS_SHOWN = 10;

export type NumberedView = {
  /** `<n>\t<line>` rows, the number padded to the widest shown. */
  text: string;
  total: number;
  start: number;
  end: number;
  /** Lines after `end` left out by the cap (0: none). */
  more: number;
};

/** A file as numbered lines, `start`..`end` (1-based, inclusive), at most
 *  `cap` lines. A range past the end is the caller's error, said here. */
export function numberedView(
  content: string,
  range: { start?: number; end?: number },
  cap: number,
): NumberedView | { error: string } {
  const { lines } = splitLines(content);
  const total = lines.length;
  for (const [k, v] of Object.entries(range)) {
    if (v !== undefined && (!Number.isInteger(v) || v < 1)) {
      return { error: `${k} must be a whole line number, 1 or more (got ${v})` };
    }
  }
  const start = range.start ?? 1;
  if (total === 0) return { text: '', total: 0, start: 0, end: 0, more: 0 };
  if (start > total) {
    return { error: `start ${start} is past the end: the file has ${total} line(s)` };
  }
  const want = Math.min(range.end ?? total, total);
  if (want < start) return { error: `end ${want} is before start ${start}` };
  const end = Math.min(want, start + cap - 1);
  const width = String(end).length;
  const text = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(width)}\t${l}`)
    .join('\n');
  return { text, total, start, end, more: want - end };
}

export type TextEdit = { old: string; new: string; replace_all?: boolean };

/**
 * Apply `edits` in order, each to the text the one before left. Each `old`
 * must be found exactly once (or at least once with `replace_all`): else
 * nothing is applied and the error names the edit, how many hits and on
 * which lines, or where a near match sits.
 */
export function applyEdits(
  content: string,
  edits: readonly TextEdit[],
  /** The longest the text may grow to, in characters (the file cap): an
   *  edit past it is refused before its text is built. */
  maxChars = Number.POSITIVE_INFINITY,
): { text: string; replaced: number } | { error: string } {
  let text = content;
  let replaced = 0;
  for (const [i, e] of edits.entries()) {
    const which = edits.length > 1 ? `edit ${i + 1} of ${edits.length}` : 'the edit';
    if (e.old === '') {
      return {
        error: `${which}: old is empty. Quote the exact text to replace; to add lines use code_insert, to write a whole file use code_write`,
      };
    }
    if (e.old === e.new) {
      return {
        error: `${which}: old and new are the same text, so it changes nothing. Put the replacement text in new`,
      };
    }
    const all = e.replace_all === true;
    const hits = offsetsOf(text, e.old, all ? 1 : HITS_SHOWN + 1);
    if (hits.length === 0) {
      const near = nearMatch(text, e.old);
      return {
        error:
          `${which}: old was not found${i > 0 ? ' (after the edits before it)' : ''}. ` +
          (near
            ? `Its first line appears, with other spacing, on line(s) ${near}: view them with code_view and copy the text exactly. `
            : 'Copy the text exactly from code_view (no line numbers, same spaces and tabs). ') +
          'Nothing was changed',
      };
    }
    if (hits.length > 1 && !all) {
      const more = hits.length > HITS_SHOWN;
      const lines = lineNumbersOf(text, hits.slice(0, HITS_SHOWN));
      return {
        error: `${which}: old matches ${more ? `more than ${HITS_SHOWN}` : hits.length} times (lines ${lines.join(', ')}${more ? ', …' : ''}). Add surrounding lines to old so it matches once, or set replace_all. Nothing was changed`,
      };
    }
    const count = all ? replaceCount(text, e.old) : 1;
    const grows = text.length + count * (e.new.length - e.old.length);
    if (grows > maxChars) {
      return {
        error: `${which}: the file would grow to ${grows} characters, past the file limit of ${maxChars}. Replace less (drop replace_all, or a shorter new), or split the file. Nothing was changed`,
      };
    }
    // split/join: no `$` patterns, and replace_all takes the matches from
    // the left without overlap.
    const parts = text.split(e.old);
    text = parts.join(e.new);
    replaced += parts.length - 1;
  }
  return { text, replaced };
}

/** Lines where `old`'s first non-blank line appears, trimmed, or null. */
function nearMatch(text: string, old: string): string | null {
  const first = old
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (!first) return null;
  const squash = (s: string) => s.replace(/\s+/g, ' ');
  const want = squash(first);
  const hits: number[] = [];
  splitLines(text).lines.forEach((l, i) => {
    if (squash(l.trim()) === want) hits.push(i + 1);
  });
  if (!hits.length) return null;
  return hits.slice(0, 10).join(', ') + (hits.length > 10 ? ', …' : '');
}

/** Insert `insert` as whole lines after line `afterLine` (0: the top). */
export function insertAfterLine(
  content: string,
  afterLine: number,
  insert: string,
): { text: string } | { error: string } {
  const { lines, trailingNewline } = splitLines(content);
  if (afterLine > lines.length) {
    return {
      error: `after_line ${afterLine} is past the end: the file has ${lines.length} line(s). Use ${lines.length} to add at the end`,
    };
  }
  const added = splitLines(insert.endsWith('\n') ? insert : insert + '\n').lines;
  const next = [...lines.slice(0, afterLine), ...added, ...lines.slice(afterLine)];
  // A file that had no last newline keeps none, unless the lines go at its end.
  return {
    text: joinLines(next, trailingNewline || afterLine === lines.length || lines.length === 0),
  };
}

type Op = { kind: ' ' | '-' | '+'; line: string };

/** The line ops from `a` to `b`: common head and tail, then an LCS of the
 *  middle while it stays small, else the middle as one replace. */
/** The most cells (lines before x lines after, past the common head and
 *  tail) one file's line match may fill; a larger change shows as the old
 *  lines removed and the new ones added. */
export const DIFF_MAX_CELLS = 2_000_000;

function lineOps(a: readonly string[], b: readonly string[], maxCells: number): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const am = a.slice(head, a.length - tail);
  const bm = b.slice(head, b.length - tail);
  const mid: Op[] = [];
  if (am.length * bm.length <= maxCells) {
    const n = am.length;
    const m = bm.length;
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] =
          am[i] === bm[j]
            ? lcs[(i + 1) * w + j + 1]! + 1
            : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        mid.push({ kind: ' ', line: am[i]! });
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!) {
        mid.push({ kind: '-', line: am[i++]! });
      } else {
        mid.push({ kind: '+', line: bm[j++]! });
      }
    }
    while (i < n) mid.push({ kind: '-', line: am[i++]! });
    while (j < m) mid.push({ kind: '+', line: bm[j++]! });
  } else {
    for (const l of am) mid.push({ kind: '-', line: l });
    for (const l of bm) mid.push({ kind: '+', line: l });
  }
  return [
    ...a.slice(0, head).map((line): Op => ({ kind: ' ', line })),
    ...mid,
    ...a.slice(a.length - tail).map((line): Op => ({ kind: ' ', line })),
  ];
}

/**
 * A unified diff of one file (3 lines of context), at most `maxLines` lines:
 * a longer one is cut and says so on its last line. Empty when nothing
 * changed.
 */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  maxLines = 400,
  /** What the cut line says to do next. */
  cutHint = 'view the file with code_view',
  /** The line match's work limit (DIFF_MAX_CELLS at most). */
  maxCells = DIFF_MAX_CELLS,
): string {
  if (before === after) return '';
  const ops = lineOps(
    splitLines(before).lines,
    splitLines(after).lines,
    Math.min(maxCells, DIFF_MAX_CELLS),
  );
  const CONTEXT = 3;
  const changed = ops.map((o) => o.kind !== ' ');
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let k = 0;
  while (k < ops.length) {
    if (!changed[k]) {
      k++;
      continue;
    }
    // A hunk: from CONTEXT before this change to CONTEXT after the last
    // change that is within 2 * CONTEXT of the one before it.
    const from = Math.max(0, k - CONTEXT);
    let last = k;
    for (let j = k + 1; j < ops.length && j <= last + 2 * CONTEXT; j++) if (changed[j]) last = j;
    const to = Math.min(ops.length, last + CONTEXT + 1);
    let aStart = 1;
    let bStart = 1;
    for (let j = 0; j < from; j++) {
      if (ops[j]!.kind !== '+') aStart++;
      if (ops[j]!.kind !== '-') bStart++;
    }
    const slice = ops.slice(from, to);
    const aLen = slice.filter((o) => o.kind !== '+').length;
    const bLen = slice.filter((o) => o.kind !== '-').length;
    out.push(
      `@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`,
      ...slice.map((o) => o.kind + o.line),
    );
    k = to;
  }
  if (out.length > maxLines) {
    const cut = out.length - maxLines;
    return [...out.slice(0, maxLines), `… diff cut: ${cut} more line(s); ${cutHint}`].join('\n');
  }
  return out.join('\n');
}

/** The most `{a,b}` alternatives a glob may expand to. */
const GLOB_MAX_ALTERNATIVES = 32;
/** The most tokens of all alternatives together: the match costs this
 *  times the path length per file. */
const GLOB_MAX_TOKENS = 2000;

type GlobToken = { kind: 'char'; c: string } | { kind: '?' | '*' | '**' | '**/' };

function globTokens(glob: string): GlobToken[] {
  const out: GlobToken[] = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '?') out.push({ kind: '?' });
    else if (c !== '*') out.push({ kind: 'char', c });
    else {
      let n = 1;
      while (glob[i + 1] === '*') {
        n++;
        i++;
      }
      if (n === 1) out.push({ kind: '*' });
      else if (glob[i + 1] === '/') {
        out.push({ kind: '**/' });
        i++;
      } else out.push({ kind: '**' });
    }
  }
  return out;
}

/** The one-level `{a,b}` expansions of a glob, or null past the cap. */
function expandBraces(glob: string): string[] | null {
  const open = glob.indexOf('{');
  const close = open === -1 ? -1 : glob.indexOf('}', open);
  if (close === -1) return [glob];
  const head = glob.slice(0, open);
  const rest = expandBraces(glob.slice(close + 1));
  if (!rest) return null;
  const out: string[] = [];
  for (const alt of glob.slice(open + 1, close).split(',')) {
    for (const tail of rest) {
      out.push(head + alt + tail);
      if (out.length > GLOB_MAX_ALTERNATIVES) return null;
    }
  }
  return out;
}

/** Whether `path` matches the tokens: one pass of a table, tokens × path
 *  characters, so no glob can make it backtrack. */
function tokensMatch(tokens: readonly GlobToken[], path: string): boolean {
  const L = path.length;
  // next[j]: tokens after this one match path[j..].
  let next = new Uint8Array(L + 1);
  next[L] = 1;
  for (let t = tokens.length - 1; t >= 0; t--) {
    const tok = tokens[t]!;
    const cur = new Uint8Array(L + 1);
    let anySlash = 0; // '**/': a '/' at k >= j with next[k + 1]
    for (let j = L; j >= 0; j--) {
      const ch = j < L ? path[j] : undefined;
      switch (tok.kind) {
        case 'char':
          cur[j] = ch === tok.c && next[j + 1] ? 1 : 0;
          break;
        case '?':
          cur[j] = ch !== undefined && ch !== '/' && next[j + 1] ? 1 : 0;
          break;
        case '*':
          cur[j] = next[j] || (ch !== undefined && ch !== '/' && cur[j + 1]) ? 1 : 0;
          break;
        case '**':
          cur[j] = next[j] || (ch !== undefined && cur[j + 1]) ? 1 : 0;
          break;
        case '**/':
          if (ch === '/' && next[j + 1]) anySlash = 1;
          cur[j] = next[j] || anySlash ? 1 : 0;
          break;
      }
    }
    next = cur;
  }
  return next[0] === 1;
}

/**
 * A file glob as a matcher: `*` any run within one path segment, `**` any
 * run across segments (`**` before a slash: none too), `?` one character,
 * `{a,b}` either. A glob with no `/` matches the file name in any folder.
 * Linear in the path for any glob (no regular expression), so a caller's
 * glob cannot stall the process; null when it expands past the caps.
 */
export function globMatcher(glob: string): ((path: string) => boolean) | null {
  const alts = expandBraces(glob);
  if (!alts) return null;
  const compiled = alts.map((g) => {
    const tokens = globTokens(g);
    return g.includes('/') ? tokens : [{ kind: '**/' } as GlobToken, ...tokens];
  });
  if (compiled.reduce((n, t) => n + t.length, 0) > GLOB_MAX_TOKENS) return null;
  return (path) => compiled.some((tokens) => tokensMatch(tokens, path));
}

/** Whether every line of a text ends in CRLF: such a file is worked on as
 *  LF (toLf) and written back with CRLF (toCrlf), exactly. A file with mixed
 *  line ends is worked on as it is. */
export function crlfOf(text: string): boolean {
  const lf = (text.match(/\n/g) ?? []).length;
  return lf > 0 && (text.match(/\r\n/g) ?? []).length === lf;
}
export const toLf = (text: string): string => text.replace(/\r\n/g, '\n');
/** Back to CRLF: every LF (each one came from a CRLF, or is a new line). */
export const toCrlf = (text: string): string => text.replace(/\n/g, '\r\n');
