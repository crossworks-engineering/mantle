/**
 * Which tool results carry THIRD-PARTY authored content and must be fenced
 * as data before the model reads them (see agent-runtime's fenceRetrieved).
 *
 * Two signals, combined at the tool-loop fencing site:
 *
 *  · SLUGS — builtins whose whole purpose is fetching external content.
 *  · the `untrusted` flag on ToolHandlerResult — set by the DISPATCH layer,
 *    which knows provenance the loop can't see: every http-kind tool result
 *    (user-authored API tools hit arbitrary endpoints), and any recipe whose
 *    chain actually ran an http step or a web builtin. A recipe composed
 *    purely of brain builtins stays unfenced — its data is the user's own.
 *
 * Single source of truth: the loop and dispatchRecipe both import this set;
 * don't redeclare it elsewhere.
 */
export const UNTRUSTED_CONTENT_TOOL_SLUGS: ReadonlySet<string> = new Set([
  'web_fetch',
  'web_search',
  // A mini app's error log: the SQL and the messages can come from a public
  // visitor of the app (apps audit 2026-10-02, item 12).
  'app_errors',
]);
