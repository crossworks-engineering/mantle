/**
 * The two answers of an item write check, for the handlers that ask it
 * themselves (/api/shares/:id, /api/apps/deleted/:id). One text for both,
 * so the answers cannot drift.
 */
import { sql } from 'drizzle-orm';
import { db, mayEditSql, mayManageSql } from '@mantle/db';
import { READ_ONLY_COPY_MESSAGE, UUID_RE } from '@mantle/std';
import { NextResponse } from '../../server/http-compat';

/** What a login hears of an item it does not read, existing or not: one
 *  answer, so the two cannot be told apart. */
export function itemNotFound(): NextResponse {
  return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
}

/** An item the login reads but may not change: the item-workspace 403, in
 *  a read-only snapshot copy's words for an edit of one. */
export function itemRefused(readOnlyCopy: boolean): NextResponse {
  return NextResponse.json(
    {
      error: 'forbidden',
      reason: 'item-workspace',
      message: readOnlyCopy
        ? READ_ONLY_COPY_MESSAGE
        : 'You cannot change this item in your workspaces.',
      ...(readOnlyCopy ? { readOnly: true } : {}),
    },
    { status: 403 },
  );
}

/**
 * A share's link check for a write to /api/shares/:id, asked in the login's
 * scope (the request's, entered by the guard). A share is a link: changing or closing it needs edit of its
 * item, manage for an app's (assertMayLink asks it again, link-serve.ts).
 * A share the scope does not read (none by this id, or its item hidden:
 * the scope reads no link of an item it does not read, 0265) is the one
 * 404; an item it reads but may not change, the 403. Null: go on.
 */
export async function shareItemRefusal(shareId: string): Promise<NextResponse | null> {
  if (!UUID_RE.test(shareId)) return itemNotFound();
  const rows = (await db.execute(sql`
    select ${mayEditSql('n')} as edit, ${mayManageSql('n')} as manage,
           coalesce(n.data ? 'snapshot_of', false) as copy, n.type::text as type
      from shares s join nodes n on n.id = s.node_id
     where s.id = ${shareId}`)) as unknown as {
    edit: boolean | null;
    manage: boolean | null;
    copy: boolean;
    type: string;
  }[];
  const row = rows[0];
  if (!row) return itemNotFound();
  const need = row.type === 'app' ? 'manage' : 'edit';
  const readOnlyCopy = row.copy === true && need === 'edit';
  if (!readOnlyCopy && (need === 'edit' ? row.edit === true : row.manage === true)) return null;
  return itemRefused(readOnlyCopy);
}
