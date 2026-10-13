/**
 * The answer to a write the database refused (isScopeWriteRefusal): one
 * mapper for the HTTP routes. The edit check (arch A3a, docs/edit-check.md)
 * adds a detail, read here into the wire's `code` (plan 10: the shape stays
 * { error, reason, message }, a stable code is added):
 *  - no_read: the caller does not read the item: 404, as any item it may
 *    not read (owner decision D2);
 *  - read_only (an Informational app's data) and ro_actor (a caller that
 *    only reads): 403, reason read-only;
 *  - no_edit, or no detail (the workspace checks before A3a): 403, reason
 *    item-workspace, as before (jackdaw's "Add yourself" keys on it).
 */
import { editRefusalDetail, isScopeWriteRefusal } from '@mantle/db';

export function scopeRefusalResponse(err: unknown): Response | null {
  if (!isScopeWriteRefusal(err)) return null;
  const detail = editRefusalDetail(err);
  if (detail === 'no_read') {
    return Response.json(
      { error: 'not found', reason: 'not-found', code: 'not_found', message: 'Not found.' },
      { status: 404 },
    );
  }
  if (detail === 'read_only' || detail === 'ro_actor') {
    return Response.json(
      {
        error: 'forbidden',
        reason: 'read-only',
        code: detail,
        message:
          detail === 'read_only'
            ? 'This app is Informational: its data is read only.'
            : 'This caller only reads: it cannot change anything.',
      },
      { status: 403 },
    );
  }
  return Response.json(
    {
      error: 'forbidden',
      reason: 'item-workspace',
      code: 'forbidden',
      message: 'You cannot change this item in your workspaces.',
    },
    { status: 403 },
  );
}
