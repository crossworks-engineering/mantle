/**
 * Whether a call's outcome carries third-party text: the one rule a run
 * item's stored result and a worker turn's reply are marked by, so a model
 * that later reads the run state (run_state, run_plan, the resume turn)
 * reads it fenced as data.
 *
 *  - A result the tool loop fences: the tool's policy says `outside.untrusted`
 *    (a web builtin), or dispatch flagged its provenance (`untrusted` on an
 *    http, connector or recipe result).
 *  - A failure of an http or connector row (its error quotes the remote
 *    answer: an http status line with the body, a remote MCP tool's error
 *    text) or of a recipe (a step's such failure), and a failure of a tool
 *    whose policy says `outside.untrusted`.
 *
 * Pure (no registry), on its own subpath so the tool loop's tests that fake
 * @mantle/tools still read it.
 */
import type { ToolHandlerResult } from './types';

/** The row kinds whose failure text quotes a remote answer. */
const REMOTE_KINDS: ReadonlySet<string> = new Set(['http', 'mcp', 'recipe']);

export function outcomeIsThirdParty(
  /** The tool's policy says `outside.untrusted` (policyUntrusted). */
  policyUntrusted: boolean,
  /** The row's handler kind (`builtin`, `http`, `mcp`, `recipe`, ...). */
  handlerKind: unknown,
  outcome: ToolHandlerResult,
): boolean {
  if (policyUntrusted) return true;
  if (outcome.ok) return outcome.untrusted === true;
  return typeof handlerKind === 'string' && REMOTE_KINDS.has(handlerKind);
}
