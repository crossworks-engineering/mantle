/** Normalise a `db.execute()` result across the array vs `{ rows }` driver
 *  shapes, so raw-SQL callers don't each re-implement the guard. */
export function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}
