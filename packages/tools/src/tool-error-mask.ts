/**
 * The one masking of a tool's database errors (workspaces W3; arch A5 step
 * 3a): a caller outside the server never reads a database error's text
 * (SQL, parameters, or with a row rule in force something about a row it
 * may not read). Every text errorMessage gave for a database error during
 * the call is collected (watchDatabaseErrors) and a reply that carries one
 * says the one mapper's words instead (publicToolError: "not found" for an
 * item the caller does not read, the generic text otherwise); the log keeps
 * the detail.
 *
 * The tool loop masks a member's, a client's or any scoped turn's calls
 * with it; dispatch masks an MCP connection's (dormant until the owner MCP
 * surface dispatches, A5 step 4).
 */
import { publicToolError } from '@mantle/std';
import { watchDatabaseErrors } from '@mantle/std/db-watch';
import type { ToolHandlerResult } from './types';

/** Run one tool call (`where` names it in the log) with its database
 *  errors masked. */
export async function maskToolDatabaseErrors(
  where: string,
  run: () => Promise<ToolHandlerResult>,
): Promise<ToolHandlerResult> {
  const watched = await watchDatabaseErrors(run);
  const outcome = watched.value;
  if (!outcome.ok && typeof outcome.error === 'string') {
    return {
      ...outcome,
      error: publicToolError(outcome.error, watched.texts, where, watched.errors),
    };
  }
  return outcome;
}
