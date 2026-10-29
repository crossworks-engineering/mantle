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
 * (policyUntrusted); no list of names is kept. Today: the web fetch and
 * search, a mini app's error log (its SQL and messages can come from a
 * public visitor), a mini app's rows over MCP (written by the app's users),
 * mail, Telegram's inbound messages and a linked brain's reads.
 */
export { policyUntrusted } from './tool-policy';
