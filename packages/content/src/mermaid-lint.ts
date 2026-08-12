/**
 * A narrow lint over ```mermaid fences in a rich-markdown body, for the one
 * mistake that silently ships a broken diagram: **an unquoted node label
 * containing parentheses**.
 *
 *     I --> R[deputy approver (backup)]      parse error, whole diagram dead
 *     I --> R["deputy approver (backup)"]    fine
 *
 * Mermaid reads the `(` as the start of a round-node shape, so the flowchart
 * fails to parse and the reader gets a red error strip where the picture should
 * be. Nothing upstream catches it: `page_create` stores any text inside the
 * fence, and the agent cannot see the render, so it reports success either way.
 * That is exactly how a diagram reached a reader broken, and it cost an hour
 * before anyone worked out what had happened.
 *
 * **Fences are found the way the real parser finds them** — a line scanner with
 * CommonMark semantics (open with N of ``` ` ``` or `~`, close with ≥N of the
 * same char, info string classified by its FIRST word, unclosed fence runs to
 * end of input, content inside a non-mermaid fence is never scanned). This
 * matters because `markdown-to-doc.ts` decides what becomes a `diagram` node
 * with those same rules: a regex that disagreed with them let
 * ` ```mermaid title=x ` fences slip past unlinted and flagged mermaid examples
 * nested inside ` ````md ` documentation blocks (both real bugs in the first
 * version of this file). The scanner is also linear — the regex it replaced
 * went quadratic on unclosed openers and whitespace-heavy bodies, stalling the
 * tool loop for seconds.
 *
 * **Deliberately not a parser.** Mermaid only parses in a browser (it reaches
 * for DOMPurify), so there is no server-side parse to run. This catches the one
 * class we have actually been bitten by and stays quiet everywhere else — a
 * false positive would block a legitimate page write, which is worse than the
 * bug it prevents. Everything ambiguous is skipped:
 *
 *   - labels already quoted (`["…"]`) — the fix itself
 *   - the other shapes, whose bodies open with a second delimiter:
 *     `[[subroutine]]`, `[(cylinder)]`, `[/parallelogram/]`, `[\trapezoid\]`
 *   - `%%` comment lines
 *   - bodies over {@link MAX_LINT_CHARS} — best-effort, never a stall
 *
 * The in-editor NodeView still shows mermaid's own error for anything this
 * misses; this rung exists so an AGENT gets told, since it has no eyes on the
 * render.
 */

/** One flagged label, with enough context to quote back in a teaching error. */
export interface MermaidLabelProblem {
  /** The node id as written, e.g. `R`. */
  node: string;
  /** The offending label text, unquoted, as it appears in the source. */
  label: string;
  /** The shape delimiters as written (`[` `]` or `{` `}`), so the error can
   *  quote the label in the node's OWN shape — rendering a `{diamond}` back as
   *  `[a box]` invites the agent to "fix" the shape along with the quotes. */
  open: string;
  close: string;
}

/** Bodies past this size skip the lint entirely: it is best-effort teaching,
 *  and a page write must never stall behind it. Matches the editor NodeView's
 *  own per-diagram render cap. */
const MAX_LINT_CHARS = 50_000;

/** A fence opener: ≥3 backticks or tildes after optional indent, then the info
 *  string. The first word of the info string names the language — same rule as
 *  marked/markdown-to-doc, so ` ```mermaid title=x ` is a mermaid fence here
 *  because it is one there. */
const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*(\S*)/;

/** A fence closer: same char as the opener, at least as many, nothing after.
 *  (Close fences carry no info string — a shorter or decorated run is body.) */
const FENCE_CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/** `ID[label]` / `ID{label}` — a node shape whose body runs to the first close.
 *  The body is captured raw; the caller decides whether it is worth flagging. */
const NODE_SHAPE_RE = /\b([A-Za-z][\w-]*)\s*(\[|\{)([^\]}\n]*)(\]|\})/g;

/** Bodies opening with one of these are a DIFFERENT shape (or already quoted),
 *  not a plain label — skip them rather than risk a false positive. */
const AMBIGUOUS_OPENERS = new Set(['"', "'", '[', '(', '{', '/', '\\']);

/** Lint one mermaid fence body. Node-shape label syntax is a flowchart thing —
 *  sequence/gantt/pie diagrams use the same brackets for unrelated purposes,
 *  so anything else is left alone. */
function lintFenceBody(
  body: readonly string[],
  problems: MermaidLabelProblem[],
  seen: Set<string>,
): void {
  if (!body.some((l) => /^[ \t]*(flowchart|graph)\b/.test(l))) return;
  for (const line of body) {
    if (/^\s*%%/.test(line)) continue; // mermaid comment
    for (const m of line.matchAll(NODE_SHAPE_RE)) {
      const [, node, open, label, close] = m;
      if (!node || !label || !open || !close) continue;
      // `[` must close with `]` and `{` with `}` — a mismatch means we cut
      // across something we do not understand.
      if ((open === '[') !== (close === ']')) continue;
      if (AMBIGUOUS_OPENERS.has(label[0]!)) continue;
      if (!label.includes('(') && !label.includes(')')) continue;
      const key = JSON.stringify([node, label]);
      if (seen.has(key)) continue;
      seen.add(key);
      problems.push({ node, label, open, close });
    }
  }
}

/** Flag unquoted node labels that contain parentheses, per mermaid fence.
 *  Returns [] for a body with no mermaid fence, no flowchart, nothing wrong,
 *  or one too large to lint cheaply. */
export function mermaidLabelProblems(source: string | undefined | null): MermaidLabelProblem[] {
  if (!source || !source.includes('mermaid')) return [];
  if (source.length > MAX_LINT_CHARS) return [];

  const problems: MermaidLabelProblem[] = [];
  const seen = new Set<string>();

  // One pass over the lines, tracking the open fence exactly as the parser
  // does. A non-mermaid fence (```` ```js ````, ` ````md `, a bare ` ``` `)
  // swallows its content — including any ```mermaid lines inside it — so an
  // example block documenting the broken form is never flagged.
  let fence: { char: string; len: number; mermaid: boolean; body: string[] } | null = null;
  const flush = () => {
    if (fence?.mermaid) lintFenceBody(fence.body, problems, seen);
    fence = null;
  };

  for (const line of source.split('\n')) {
    if (fence) {
      const close = line.match(FENCE_CLOSE_RE);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.len) {
        flush();
      } else {
        fence.body.push(line);
      }
      continue;
    }
    const open = line.match(FENCE_OPEN_RE);
    if (open) {
      fence = {
        char: open[1]![0]!,
        len: open[1]!.length,
        mermaid: (open[2] ?? '').toLowerCase() === 'mermaid',
        body: [],
      };
    }
  }
  flush(); // an unclosed fence runs to end of input, same as the parser

  return problems;
}
