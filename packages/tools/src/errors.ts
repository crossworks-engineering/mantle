/**
 * Error hygiene for tool results.
 *
 * Two concerns live here, both about the string the MODEL ultimately reads:
 *
 *  1. TEACHING SHAPE — `notFound()` standardises the most common handler
 *     error so every miss tells the model how to recover (see the error
 *     style guide in packages/tools/CLAUDE.md: every ok:false answers
 *     "what do I do instead").
 *
 *  2. INJECTION HYGIENE — `sanitizeToolError()` strips instruction-framing
 *     from error text before it re-enters the conversation. Error strings
 *     can embed EXTERNAL content (dispatchHttp quotes the response body; a
 *     recipe step forwards an inner tool's error), and unlike successful
 *     results they historically bypassed the untrusted-content fence. A
 *     hostile endpoint must not be able to fake a fence boundary, a role
 *     tag, or a wall of junk via a crafted error body.
 */

export type NotFoundResult = { ok: false; error: string };

/**
 * Standard teaching error for an id that resolved to nothing.
 *
 *   notFound('page', pageId, 'page_list / search_nodes')
 *   → "page 1a2b… not found — it may have been deleted or the id mistyped.
 *      Find the right id with page_list / search_nodes, then re-issue."
 */
export function notFound(kind: string, id: string, lookup: string): NotFoundResult {
  return {
    ok: false,
    error:
      `${kind} ${id} not found — it may have been deleted or the id mistyped. ` +
      `Find the right id with ${lookup}, then re-issue.`,
  };
}

/** Cap for a single error string reaching the model. Long enough for a recipe
 *  chain's context + an HTTP body excerpt; short enough that a hostile
 *  endpoint can't flood the turn through the error path. */
const MAX_ERROR_LEN = 2000;

/** Matches fakes of the retrieved-content fence markers used by
 *  agent-runtime's `fenceRetrieved` — keep in sync with messages.ts. */
const FENCE_MARKER_RE = /\[(?:BEGIN|END) RETRIEVED CONTENT[^\]]*\]/gi;

/** Role/turn-framing tags a crafted error body could use to pose as
 *  conversation structure rather than data. Covers both XML-style
 *  (`<system>`, `</assistant>`) and ChatML pipe-style (`<|im_start|>`). */
const ROLE_TAG_RE =
  /<\/?\s*(?:system|user|assistant|tool|human|function_call|system-reminder|im_start|im_end)\b[^>]*>|<\|im_(?:start|end)\|>/gi;

/**
 * Sanitise one tool-error string for model consumption: defang fence-marker
 * fakes, strip role tags / code-fence runs / CDATA framing, collapse the
 * length. Applied centrally by the tool-loop to every failed call's payload —
 * individual handlers keep writing plain descriptive errors and never need
 * to think about this.
 */
export function sanitizeToolError(msg: string): string {
  if (!msg) return msg;
  let s = msg;
  s = s.replace(FENCE_MARKER_RE, '[marker removed]');
  s = s.replace(ROLE_TAG_RE, '');
  s = s.replace(/```+/g, '');
  s = s.replace(/<!\[CDATA\[|\]\]>/g, '');
  if (s.length > MAX_ERROR_LEN) s = `${s.slice(0, MAX_ERROR_LEN - 1)}…`;
  return s;
}
