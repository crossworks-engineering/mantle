/**
 * Which tool results carry THIRD-PARTY authored content and must be fenced
 * as data before the model reads them (see agent-runtime's fenceRetrieved).
 *
 * Two signals, combined at the tool-loop fencing site:
 *
 *  · the policy — builtins whose whole purpose is fetching external content
 *    declare `outside.untrusted` (tool-policy.ts policyUntrusted).
 *  · the `untrusted` flag on ToolHandlerResult — set by the DISPATCH layer,
 *    which knows provenance the loop can't see: every http-kind tool result
 *    (user-authored API tools hit arbitrary endpoints), and any recipe whose
 *    chain actually ran an http step or a web builtin. A recipe composed
 *    purely of brain builtins stays unfenced — its data is the user's own.
 *
 * One rule: the loop and dispatchRecipe both read the tool's policy
 * (policyUntrusted); no list of names is kept (A5 step 6a deleted
 * UNTRUSTED_CONTENT_TOOL_SLUGS, its view). Today: the web fetch and
 * search, a mini app's error log (its SQL and messages can come from a
 * public visitor, apps audit 2026-10-02, item 12), a mini app's rows over
 * MCP (written by the app's users, team apps Phase 1), mail, Telegram's
 * inbound messages and a linked brain's reads (A5 step 5).
 */
export { policyUntrusted } from './tool-policy';
