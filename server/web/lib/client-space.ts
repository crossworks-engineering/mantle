/**
 * The HTTP side of a CLIENT's own space (client logins C5, plan section 6):
 * the client twins of the member space helpers (lib/member-space.ts). Every
 * client space route runs its work through `inMyClientSpace`: one short
 * transaction on the personal-space role for the client's own space, at
 * level client (withSpace reads the level from the login's row), so row
 * level security holds every read and write to it and the role-aware limits
 * (space-limits.ts) are the client's.
 *
 * A client works with pages, notes and files only (CLIENT_ITEM_KINDS): any
 * other kind that ever sat in a client's space answers 404 here. There is
 * no share and no team-drafts route for a client: their item is private
 * until they submit it.
 */
import { NextResponse } from '@/server/http-compat';
import { isClientItemKind } from '@mantle/client-types/member-kinds';
import type { NodeComment } from '@mantle/client-types';
import { withSpace, type NodeCommentDbRow } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import {
  CLIENT_DOC_MAX_BYTES,
  CLIENT_NOTE_MAX_CHARS,
  SpaceItemStateError,
  getMineRow,
  loadPreferencesFor,
  toNodeCommentDto,
  type SpaceItemRow,
} from '@mantle/content';
import type { ClientCaller } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { MEMBER_WRITES_PER_MIN, withAdminGuard } from '@/lib/member-space';

/** Run `fn` inside the client's own space (at level client). */
export function inMyClientSpace<T>(client: ClientCaller, fn: () => Promise<T>): Promise<T> {
  return withSpace({ spaceId: client.spaceId, loginId: client.loginId }, fn);
}

/**
 * The client's own item, of a client kind, or a 404 (`not-found`) thrown as
 * a SpaceItemStateError: an id of another space, and a drawing or table if
 * one ever sat in a client's space, answer as a missing item. Run inside
 * `inMyClientSpace`.
 */
export async function assertClientItem(spaceId: string, id: string): Promise<SpaceItemRow> {
  const row = await getMineRow(spaceId, id);
  if (!row || !isClientItemKind(row.type)) {
    throw new SpaceItemStateError('not-found', 'Not found.');
  }
  return row;
}

/** An item of this client's that a reviewer took over: 409 `with-admin`, as
 *  for a member (the check is by login). */
export function clientWithAdminGuard(client: ClientCaller, id: string): Promise<Response | null> {
  return withAdminGuard(client, id);
}

/** Writes a client may make to their space per login per minute: the same
 *  count as a member's (the editor autosaves 800 ms after a pause, up to
 *  about 75 a minute while typing, so a lower count would refuse ordinary
 *  typing). What a write may carry is smaller (audit I3): a page document
 *  of at most 500 KB instead of 2 MB, so the worst case is a quarter of a
 *  member's. */
export const CLIENT_WRITES_PER_MIN = MEMBER_WRITES_PER_MIN;

/** A 400 `too-large` for a client's page or note over its size (C5 audit,
 *  I3). */
function tooLarge(error: string): Response {
  return NextResponse.json({ error, reason: 'too-large' }, { status: 400 });
}

/** A client's page document over 500 KB serialized: the 400, else null. */
export function clientDocTooLarge(doc: unknown): Response | null {
  if (doc === undefined) return null;
  return Buffer.byteLength(JSON.stringify(doc), 'utf8') > CLIENT_DOC_MAX_BYTES
    ? tooLarge(`A page can be at most ${CLIENT_DOC_MAX_BYTES / 1000} KB. Split it into two.`)
    : null;
}

/** A client's note over 50,000 characters: the 400, else null. */
export function clientNoteTooLarge(content: string | undefined): Response | null {
  return content !== undefined && content.length > CLIENT_NOTE_MAX_CHARS
    ? tooLarge(
        `A note can be at most ${CLIENT_NOTE_MAX_CHARS.toLocaleString('en-US')} characters. Split it into two.`,
      )
    : null;
}

/**
 * The per-login rate limit on every client write route: a 429 with
 * Retry-After, or null to go on. Checked before the body is read. Its own
 * key (`client-writes:<login>`), so a client and a member never share a
 * budget.
 */
export function clientWriteGate(client: ClientCaller): Response | null {
  const gate = rateLimit(`client-writes:${client.loginId}`, {
    max: CLIENT_WRITES_PER_MIN,
    windowMs: 60_000,
  });
  if (gate.ok) return null;
  return NextResponse.json(
    { error: 'Too many changes at once. Wait a moment, then try again.', reason: 'rate-limit' },
    { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
  );
}

/** A client's display name for a comment snapshot. */
export function clientAuthor(client: ClientCaller): { loginId: string; name: string } {
  const name = client.displayName?.trim() || client.email.split('@')[0] || 'Client';
  return { loginId: client.loginId, name };
}

/** What a client sees as the author of a reviewer's comment: the brand. */
export const REVIEWER_FALLBACK_NAME = 'Reviewer';

/** The brain's brand name (the client shell's `siteName`), the name every
 *  reviewer's comment wears for a client. A failed read answers the
 *  fallback (logged), never a staff name and never a failed thread. */
export async function brandName(anchorId: string): Promise<string> {
  try {
    const prefs = await loadPreferencesFor(anchorId);
    return prefs.siteName?.trim() || REVIEWER_FALLBACK_NAME;
  } catch (err) {
    console.error('[client-space] brand read failed:', errorMessage(err));
    return REVIEWER_FALLBACK_NAME;
  }
}

/**
 * A comment as a client reads it: their own as written (`mine` by login),
 * anyone else's under the brand name, never a staff name. Row security
 * shows a client only a reviewer's review talk and their own (0194); the
 * brand covers any other author kind too.
 */
export function clientCommentDto(
  row: NodeCommentDbRow,
  client: ClientCaller,
  brand: string,
): NodeComment {
  const dto = toNodeCommentDto(row, { loginId: client.loginId });
  const own = row.authorKind === 'client' && row.loginId === client.loginId;
  return own ? dto : { ...dto, authorName: brand };
}
