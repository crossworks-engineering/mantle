/**
 * Doc heading quotes: a `docs/<file>.md, "Heading"` quote in code, SQL,
 * scripts or a live doc must name a heading that exists. Read by
 * scripts/docs-check.mjs (which fails on a quote that names none) and by
 * arch-counts.mjs (actorsHistoryRefs, actorsMdLines).
 *
 * What counts as a heading: a markdown heading, or the bold lead of a
 * paragraph or list item (`**Label.** text`). A quote names one when it is
 * the heading's text or a whole-word prefix of it (headings carry a date, a
 * migration or a suffix: "Pre-check deletion" names "Pre-check deletion (A4
 * step 4)"), ignoring case, backticks and a leading section number ("4b.").
 *
 * docs/actors.md is the spec; its history moved verbatim to
 * docs/_archive/actors-history.md. A docs/actors.md quote resolves against
 * the spec first and the archive second. The quotes that resolve only
 * through the archive are actorsHistoryRefs: pinned in
 * scripts/arch-scoreboard.pins.json, only down, until each points at a spec
 * section or is dropped.
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

/** `file: doc, "quote"` of each quote that named no heading on main at
 *  v0.300.83. docs/actors.md's four go with D2's retarget. */
export const DANGLING = [
  'eslint-rules/as-system-allowlist.mjs: docs/actors.md, "A6"',
  'eslint-rules/route-plumbing.mjs: docs/request-plumbing.md, "Left open"',
  'packages/db/migrations/0213_mobile_roles_push.sql: docs/mobile-companion-backend.md, "Three roles on the phone"',
  'packages/db/migrations/0215_tool_team_apps.sql: docs/member-logins.md, "Outside tools in team apps"',
  'packages/db/migrations/0280_edit_check.sql: docs/actors.md, "A3a must"',
  'server/web/server/a10-cache-sweep.test.ts: docs/request-plumbing.md, "Cache-Control"',
  'server/web/server/a8-findings.db.test.ts: docs/actors.md, "A8 findings"',
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
// `docs/x.md, "H"`, `docs/x.md "H"`, the comma at a line end, and the
// escaped `\"H\"` of a JSON or TS string.
const QUOTE = new RegExp(
  String.raw`docs\/([A-Za-z0-9_./-]+\.md)(?:,[ \t]*|[ \t]+|,${CONT})\\?"((?:[^"\\\n]|${CONT})+?)\\?"`,
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

/** Does `quote` name one of `headings` (the text, or a whole-word prefix)? */
export function namesHeading(headings, quote) {
  const q = normHeading(quote);
  if (!q) return false;
  return headings.some(
    (h) => h === q || (h.startsWith(q) && /[\s:(,.{;-]/.test(h.charAt(q.length))),
  );
}

/** Every heading quote in `text`, with its 1-based line. */
export function quotesIn(text) {
  const out = [];
  for (const m of text.matchAll(QUOTE)) {
    out.push({
      doc: `docs/${m[1]}`,
      quote: m[2].replace(CONT_RE, ' ').trim(),
      line: text.slice(0, m.index).split('\n').length,
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
 * problems, historyRefs, dangling, actorsHistoryRefs, docQuotesDangling,
 * actorsMdLines }: `problems` names each quote of no heading (or of a doc
 * that does not exist) that DANGLING does not list, and each DANGLING
 * entry that no longer dangles; `historyRefs` each docs/actors.md quote
 * that resolves only through the archive; `dangling` each listed one.
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
    for (const q of quotesIn(text)) {
      quotes++;
      const key = `${f}: ${q.doc}, "${q.quote}"`;
      const where = `${f}:${q.line}: ${q.doc}, "${q.quote}"`;
      const hs = headings(q.doc);
      if (hs !== null && namesHeading(hs, q.quote)) continue;
      if (q.doc === SPEC && namesHeading(headings(ARCHIVE) ?? [], q.quote)) {
        historyRefs.push(where);
        continue;
      }
      if (listed.has(key)) {
        dangling.push(key);
        continue;
      }
      problems.push(`${where}: ${hs === null ? 'the doc does not exist' : 'names no heading'}`);
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
    dangling,
    actorsHistoryRefs: historyRefs.length,
    docQuotesDangling: dangling.length,
    actorsMdLines,
  };
}
