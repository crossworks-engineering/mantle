import { z } from 'zod';

/**
 * Shared request shape for the two app db-broker routes (owner + share).
 *
 * The params ceiling matches SQLite's own default variable limit
 * (SQLITE_MAX_VARIABLE_NUMBER = 999). The old cap of 100 was far below the
 * engine's, and real apps hit it: a batched multi-row upsert of an 18-column
 * table died at 40 rows (720 params) with a bare "invalid input" while the
 * author had correctly sized the batch against SQLite's 999. The broker cap
 * must never be the lower of the two, or the error names neither the field
 * nor the limit.
 */
export const APP_DB_MAX_PARAMS = 999;

export const AppDbBody = z.object({
  op: z.enum(['query', 'exec']),
  sql: z.string().min(1).max(20_000),
  params: z.array(z.unknown()).max(APP_DB_MAX_PARAMS).optional().default([]),
});

/** Name the failing field so an app author sees WHAT was refused, not just
 *  "invalid input" — the opaque form cost a real field debugging session. */
export function appDbBodyError(err: z.ZodError): string {
  const issue = err.issues[0];
  const where = issue?.path?.length ? issue.path.join('.') : 'body';
  return `invalid input — ${where}: ${issue?.message ?? 'malformed request'}`;
}
