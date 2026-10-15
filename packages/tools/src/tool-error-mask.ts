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
 * with it; dispatch masks an MCP connection's (A5 step 4). An error an MCP
 * call throws is answered by thrownToolDatabaseError, step 8 of the gate
 * for the throws the gate's mapper does not read (the one place the owner
 * MCP surface's registration catch, once tool-input.ts's, now asks).
 */
import {
  databaseErrorPublic,
  isDatabaseError,
  isProviderHttpFailure,
  publicProviderErrorMessage,
  publicToolError,
} from '@mantle/std';
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

/**
 * What an MCP call says for an error thrown to its surface (A5 step 4): a
 * database error in the one mapper's words (databaseErrorPublic; logged in
 * full under `where`); a model provider's HTTP failure (a query embed's, an
 * SDK's) in its fixed sentence, never the provider's body (A10 #10 fix round
 * 2, logged likewise); or null: any other error goes on to the SDK, which
 * answers its message, as the surface always has.
 */
export function thrownToolDatabaseError(where: string, err: unknown): string | null {
  if (isProviderHttpFailure(err)) return publicProviderErrorMessage(err, where);
  if (!isDatabaseError(err)) return null;
  console.error(`[${where}] database error:`, err);
  return databaseErrorPublic(err);
}
