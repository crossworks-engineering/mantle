import { policySlugSet } from './tool-policy';

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
 * don't redeclare it elsewhere. A view of the tool policy table
 * (tool-policy.ts, A5): `outside.untrusted`. Today: the web fetch and
 * search, a mini app's error log (its SQL and messages can come from a
 * public visitor, apps audit 2026-10-02, item 12) and a mini app's rows over
 * MCP (written by the app's users, team apps Phase 1).
 */
export const UNTRUSTED_CONTENT_TOOL_SLUGS: ReadonlySet<string> = policySlugSet(
  (p) => p.outside?.untrusted === true,
);
