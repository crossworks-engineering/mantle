import { z } from 'zod';
import { NextResponse } from '@/server/http-compat';
import { AppSqlBusyError, AppSqlError } from '@mantle/content/app-broker';

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
export function appDbErrorResponse(err: unknown, where: string): NextResponse {
  if (err instanceof AppSqlBusyError) {
    return NextResponse.json(
      { ok: false, error: err.message, reason: 'busy' },
      { status: 429, headers: { 'retry-after': '1' } },
    );
  }
  if (err instanceof AppSqlError) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
  }
  console.error(`[${where}] app database error:`, err);
  return NextResponse.json(
    { ok: false, error: "The app's database is not available right now. Try again later." },
    { status: 500 },
  );
}
