/** The first validation problem as a one-line message for a 400 body.
 *  Replaces the `parsed.error.issues[0]?.message ?? 'invalid input'` idiom
 *  that 90+ routes carried inline (2026-09-02 audit). Names the failing path
 *  when zod recorded one, which the inline form never did. */
export function firstIssue(
  error: { issues: ReadonlyArray<{ message?: string; path?: ReadonlyArray<PropertyKey> }> },
  fallback = 'invalid input',
): string {
  const issue = error.issues[0];
  if (!issue?.message) return fallback;
  const where = issue.path?.filter((p) => typeof p !== 'symbol').join('.');
  return where ? `${where}: ${issue.message}` : issue.message;
}
