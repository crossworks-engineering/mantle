/**
 * Per-login rows on the settings area's diagnostic reads (/api/debug/*).
 *
 * A row with `login_id` set (a chat, a fact learned from one, an area
 * screenshot, a responder turn's trace) is its login's alone. Row security
 * holds it there on a scoped read, but the diagnostic routes read on the
 * system pool, which binds no login, so each read says it itself: such a
 * row shows only to that login (`login_id is null or login_id = <login>`).
 * The login is the caller's own (the actor: an Admin user's, the owner's),
 * never the brain's.
 */
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** `column` (a `login_id`) is unset, or names `login`. */
export function shownToLogin(column: SQLWrapper, login: string): SQL {
  return sql`(${column} is null or ${column} = ${login}::uuid)`;
}
