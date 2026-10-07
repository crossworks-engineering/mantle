import { z } from 'zod';
import { NextResponse } from '@/server/http-compat';
import { recordAppError, type AppErrorEntry } from '@mantle/content';
import { AppDbMissingError, AppSqlBusyError, AppSqlError } from '@mantle/content/app-broker';

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

/**
 * The answer to a failed broker statement (client tier audit L4, I1). An
 * error the app's own SQL earned (AppSqlError: its SQL, a refusal, a cap,
 * the time limit) keeps its message, for the app author; a busy pool or
 * caller is a 429 to retry. Anything else is the server's own trouble (a
 * missing volume, a permission, the database) and its text can name a path
 * on the server or the brain's id, so the caller gets a generic message and
 * the log gets the rest.
 */
/** Where a broker's error is logged for the app's owner (apps first-class
 *  plan G4): the app, who ran it, and the statement. */
export type AppDbErrorLog = Omit<AppErrorEntry, 'source' | 'message' | 'status'>;

export function appDbErrorResponse(err: unknown, where: string, log?: AppDbErrorLog): NextResponse {
  if (err instanceof AppSqlBusyError) {
    // A wait, not a fault: the kit retries it, so it is not logged.
    return NextResponse.json(
      { ok: false, error: err.message, reason: 'busy' },
      { status: 429, headers: { 'retry-after': '1' } },
    );
  }
  const answer = (error: string, status: number, extra: Record<string, unknown> = {}) => {
    if (log) recordAppError({ ...log, source: 'db', message: error, status });
    return NextResponse.json({ ok: false, error, ...extra }, { status });
  };
  if (err instanceof AppSqlError) return answer(err.message, 400);
  if (err instanceof AppDbMissingError) {
    // Lost on the server (apps audit D1): logged in full where it was found;
    // the caller hears what happened, not where the file lived.
    return answer(
      "This app's data is missing on the server. The owner has to restore it from a backup.",
      503,
      { reason: 'missing' },
    );
  }
  console.error(`[${where}] app database error:`, err);
  return answer("The app's database is not available right now. Try again later.", 500);
}
