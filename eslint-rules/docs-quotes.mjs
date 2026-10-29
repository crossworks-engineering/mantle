/**
 * Doc heading quotes: a `docs/<file>.md, "Heading"` quote in code, SQL,
 * scripts or a live doc must name a heading that exists. Read by
 * scripts/docs-check.mjs (which fails on a quote that names none) and by
 * arch-counts.mjs (actorsHistoryRefs, actorsStepRefs, docQuotesDangling,
 * actorsMdLines).
 *
 * The forms read: `docs/x.md, "H"`, `docs/x.md "H"`, `docs/x.md ("H")`, the
 * comma at a line end with the quote on the next comment line, the escaped
 * `\"H\"` of a JSON or TS string, and curly quotes (`“H”`). A colon form
 * (`docs/x.md: "text"`) quotes the doc's words, not a heading: it is never
 * a problem, but one that names a heading counts like any quote, so it is
 * no way around a history ref.
 *
 * What counts as a heading: a markdown heading, or the bold lead of a
 * paragraph or list item (`**Label.** text`). A quote names one when it is
 * the heading's text or a whole-word prefix of it (headings carry a date, a
 * migration or a suffix: "Pre-check deletion" names "Pre-check deletion
 * (0280)"), ignoring case, backticks and a leading section number ("4b.").
 * A word ends at a space or a mark, never a hyphen: "Pre" names no
 * "Pre-check ..." heading. A quote that is no heading's whole text and a
 * prefix of two or more different headings of its doc names none: it fails
 * as ambiguous.
 *
 * docs/actors.md is the spec; its history moved verbatim to
 * docs/_archive/actors-history.md. A docs/actors.md quote resolves against
 * the spec first and the archive second. History refs (actorsHistoryRefs,
 * pinned in scripts/arch-scoreboard.pins.json, only down) are the quotes
 * that resolve only through the archive, and every quote of a docs/_archive/
 * file (counted, not refused: pointing a quote at the archive by name moves
 * no count). Step refs (actorsStepRefs, the same pins, only down) are the
 * unquoted pointers to the history by a step's code:
 * `docs/actors.md, B4 step 3b`, `(docs/actors.md, fixed by B6)`.
 *
 * Scanned: every tracked text file except the history (docs/_archive,
 * docs/_changelog, CHANGELOG.md), whose quotes name headings as they were,
 * and this rule's own files.
 *
 * DANGLING names the quotes that named no heading when this check came in
 * (a heading renamed or never written; three sit in applied migrations,
 * which are never edited). The list only shrinks: an entry that resolves
 * or is gone fails the check until it is removed, and a new quote of no
 * heading is never added here (fix the quote or the doc).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SPEC = 'docs/actors.md';
export const ARCHIVE = 'docs/_archive/actors-history.md';

/** `file: doc, "quote"` of each known quote that names no heading. The
 *  list only shrinks: an entry that no longer dangles is a problem. */
export const DANGLING = [
  'packages/db/migrations/0213_mobile_roles_push.sql: docs/mobile-companion-backend.md, "Three roles on the phone"',
  'packages/db/migrations/0215_tool_team_apps.sql: docs/member-logins.md, "Outside tools in team apps"',
  'packages/db/migrations/0280_edit_check.sql: docs/actors.md, "A3a must"',
  'server/web/server/a8-surfaces.matrix.test.ts: docs/actors.md, "A pending tool call, approved"',
];

const TEXT_FILE = /\.(ts|tsx|mts|mjs|cjs|js|sql|md|sh|ya?ml|json)$/;
const HISTORY = /^(docs\/_archive\/|docs\/_changelog\/|CHANGELOG\.md$)/;
// This rule's own files: DANGLING and the test's fixtures are quotes that
// name no heading on purpose.
const SELF = new Set(['eslint-rules/docs-quotes.mjs', 'eslint-rules/docs-quotes.test.ts']);

// A quote may wrap onto the next comment line: a newline, then a comment
// marker (`*`, `//`, `#`, `--`) or none.
const CONT = String.raw`\n[ \t]*(?:\*(?!\/)|\/\/|#|--)?[ \t]*`;
const PATH = String.raw`docs\/([A-Za-z0-9_./-]+\.md)`;
// Between the path and the quote: a comma or colon (then spaces, or the
// line end), or spaces, each with an optional `(`; or a `(` alone. Never
// nothing: `"docs/x.md" and "y"` is a path closing a string. A colon marks
// the quote soft (see above).
const SEP = String.raw`(?:(?:[,:][ \t]*|[,:]${CONT}|[ \t]+)\(?|\()`;
// `"H"`, the escaped `\"H\"`, or curly `“H”`.
const BODY = String.raw`(?:\\?"((?:[^"\\\n]|${CONT})+?)\\?"|“((?:[^”\n]|${CONT})+?)”)`;
const QUOTE = new RegExp(PATH + SEP + BODY, 'g');
// An unquoted pointer to the history by a step's code: the spec or an
// archive file, a comma, colon or `(`, at most two lower-case words
// ("the", "fixed by"), then a code (B4, B6b, C1, X7c).
const STEP = new RegExp(
  String.raw`docs\/(actors\.md|_archive\/[A-Za-z0-9_./-]+\.md)(?:[,:](?:[ \t]*|${CONT})|[ \t]*\([ \t]*)((?:[a-z]+[ \t]+){0,2}[A-Z]{1,2}\d+[a-z]?)(?![A-Za-z0-9])`,
  'g',
);
const CONT_RE = new RegExp(CONT, 'g');

/** Lower-case, no backticks or emphasis, no leading section number. */
export function normHeading(s) {
  return s
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\d+[a-z]?(?:\.\d+)*\.?\s+/i, '')
    .replace(/[.:]$/, '')
    .toLowerCase();
}

/** The headings of a markdown text: `#` headings outside code fences and
 *  the bold leads of paragraphs and list items. */
export function headingsOf(text) {
  const out = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push(normHeading(h[1]));
      continue;
    }
    const b = /^\s*(?:[-*+]\s+|\d+\.\s+)?\*\*([^*]+?)\*\*/.exec(line);
    if (b) out.push(normHeading(b[1]));
  }
  return out;
}

/** What `quote` names in `headings`: 'exact' (a heading's whole text),
 *  'prefix' (a whole-word prefix of exactly one distinct heading),
 *  'ambiguous' (a prefix of two or more), or null. A word ends at a space
 *  or a mark, never inside a hyphenated word. */
export function matchHeading(headings, quote) {
  const q = normHeading(quote);
  if (!q) return null;
  if (headings.includes(q)) return 'exact';
  const hits = new Set(
    headings.filter((h) => h.startsWith(q) && /[\s:(,.{;]/.test(h.charAt(q.length))),
  );
  if (hits.size === 0) return null;
  return hits.size === 1 ? 'prefix' : 'ambiguous';
}

/** Does `quote` name one of `headings` (the text, or a whole-word prefix of
 *  one heading only)? */
export function namesHeading(headings, quote) {
  const m = matchHeading(headings, quote);
  return m === 'exact' || m === 'prefix';
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** Every heading quote in `text`, with its 1-based line; `soft` for the
 *  colon form. */
export function quotesIn(text) {
  const out = [];
  for (const m of text.matchAll(QUOTE)) {
    const q = {
      doc: `docs/${m[1]}`,
      quote: (m[2] ?? m[3]).replace(CONT_RE, ' ').trim(),
      line: lineAt(text, m.index),
    };
    if (m[0].charAt(`docs/${m[1]}`.length) === ':') q.soft = true;
    out.push(q);
  }
  return out;
}

/** Every unquoted step pointer to the history in `text` (STEP). */
export function stepRefsIn(text) {
  const out = [];
  for (const m of text.matchAll(STEP)) {
    out.push({
      doc: `docs/${m[1]}`,
      step: m[2].replace(/\s+/g, ' '),
      line: lineAt(text, m.index),
    });
  }
  return out;
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((f) => f && TEXT_FILE.test(f) && !HISTORY.test(f) && !SELF.has(f));
}

/**
 * Check every heading quote of the repo at `root`. Returns { quotes,
 * problems, historyRefs, stepRefs, dangling, actorsHistoryRefs,
 * actorsStepRefs, docQuotesDangling, actorsMdLines }: `problems` names each
 * quote of no heading, of two or more (ambiguous), or of a doc that does not
 * exist, that DANGLING does not list, and each DANGLING entry that no longer
 * dangles; `historyRefs` each history ref (a docs/actors.md quote that
 * resolves only through the archive, or any docs/_archive/ quote that
 * resolves); `stepRefs` each unquoted step pointer; `dangling` each listed
 * one.
 */
export function checkDocQuotes(root, files = trackedFiles(root), allowed = DANGLING) {
  const cache = new Map();
  const headings = (doc) => {
    if (!cache.has(doc)) {
      const p = join(root, doc);
      cache.set(doc, existsSync(p) ? headingsOf(readFileSync(p, 'utf8')) : null);
    }
    return cache.get(doc);
  };
  const problems = [];
  const historyRefs = [];
  const stepRefs = [];
  const dangling = [];
  const listed = new Set(allowed);
  let quotes = 0;
  for (const f of files) {
    let text;
    try {
      text = readFileSync(join(root, f), 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('docs/')) continue;
    for (const s of stepRefsIn(text)) stepRefs.push(`${f}:${s.line}: ${s.doc}, ${s.step}`);
    for (const q of quotesIn(text)) {
      const key = `${f}: ${q.doc}, "${q.quote}"`;
      const where = `${f}:${q.line}: ${q.doc}, "${q.quote}"`;
      const hs = headings(q.doc);
      let m = hs === null ? null : matchHeading(hs, q.quote);
      let history = q.doc.startsWith('docs/_archive/');
      if (m === null && q.doc === SPEC) {
        m = matchHeading(headings(ARCHIVE) ?? [], q.quote);
        history = true;
      }
      if (m === 'exact' || m === 'prefix') {
        quotes++;
        if (history) historyRefs.push(where);
        continue;
      }
      if (q.soft) continue;
      quotes++;
      if (listed.has(key)) {
        dangling.push(key);
        continue;
      }
      problems.push(
        `${where}: ${
          hs === null
            ? 'the doc does not exist'
            : m === 'ambiguous'
              ? 'names two or more headings by a prefix (quote one whole)'
              : 'names no heading'
        }`,
      );
    }
  }
  for (const key of listed) {
    if (!dangling.includes(key)) {
      problems.push(`DANGLING lists ${key}, which no longer dangles: remove the entry`);
    }
  }
  const spec = join(root, SPEC);
  const actorsMdLines = existsSync(spec)
    ? readFileSync(spec, 'utf8').replace(/\n$/, '').split('\n').length
    : 0;
  return {
    quotes,
    problems,
    historyRefs,
    stepRefs,
    dangling,
    actorsHistoryRefs: historyRefs.length,
    actorsStepRefs: stepRefs.length,
    docQuotesDangling: dangling.length,
    actorsMdLines,
  };
}
