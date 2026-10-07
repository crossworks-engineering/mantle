/**
 * The body of POST /api/member/chat/read and /api/client/chat/read: `{}` (or
 * no body) marks the thread read up to now; `{ at }` up to that ISO time.
 */
export function parseReadBody(
  body: unknown,
): { ok: true; at?: Date } | { ok: false; error: string } {
  if (body === null || body === undefined) return { ok: true };
  if (typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'invalid_body' };
  const at = (body as { at?: unknown }).at;
  if (at === undefined || at === null) return { ok: true };
  if (typeof at !== 'string' || at.length > 64) return { ok: false, error: 'invalid_body' };
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return { ok: false, error: 'invalid_body' };
  return { ok: true, at: when };
}
