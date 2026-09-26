/**
 * The HTTP side of a member's personal space (member logins Phase 2). Every
 * member space route runs its work through `inMySpace`: one short transaction
 * on the personal-space role for the caller's own space, so row level
 * security holds every read and write to it. There is no owner filter in the
 * routes to get wrong.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withSpace } from '@mantle/db';
import { SCENE_SVG_MAX_BYTES, SpaceItemStateError, sceneWithinLimits } from '@mantle/content';
import type { MemberCaller } from '@/lib/auth';

/** Run `fn` inside the member's own space. */
export function inMySpace<T>(member: MemberCaller, fn: () => Promise<T>): Promise<T> {
  return withSpace({ spaceId: member.spaceId, loginId: member.loginId }, fn);
}

export const SpaceIdParams = z.object({ id: z.string().uuid() });

/** A state refusal (frozen, not a draft, unsaved edits) as a 409 the member
 *  can read, not-found as a 404; anything else rethrows to the opaque 500. */
export function spaceStateResponse(err: unknown): Response {
  if (err instanceof SpaceItemStateError) {
    const status = err.reason === 'not-found' ? 404 : 409;
    return NextResponse.json({ error: err.message, reason: err.reason }, { status });
  }
  throw err;
}

export const notFound = () => NextResponse.json({ error: 'Not found.' }, { status: 404 });

/** A stale draft etag, in the owner routes' shape. */
export const conflict = (rev: number) =>
  NextResponse.json(
    {
      error: 'The draft changed since you loaded it. Reload, then apply your edit again.',
      current_rev: rev,
    },
    { status: 409 },
  );

/** A page document's size cap for members (serialized JSON). The owner's page
 *  routes have none; a member is a less trusted writer. */
export const MEMBER_DOC_MAX_BYTES = 2_000_000;

const Doc = z
  .record(z.string(), z.unknown())
  .refine((d) => Buffer.byteLength(JSON.stringify(d), 'utf8') <= MEMBER_DOC_MAX_BYTES, {
    message: 'document too large',
  });
const Scene = z.record(z.string(), z.unknown()).refine(sceneWithinLimits, {
  message: 'scene too large',
});

/** Autosave body: a page's `doc` or a drawing's `scene`, plus the etag. */
export const DraftBody = z.object({
  doc: Doc.optional(),
  scene: Scene.optional(),
  if_rev: z.number().int().nonnegative().optional(),
});

/** Save-version body: as the draft, plus a drawing's SVG snapshot (what
 *  teammates see). Bounded in bytes, like the owner's draw commit. */
export const SaveBody = DraftBody.extend({
  svg: z
    .string()
    .refine((s) => Buffer.byteLength(s, 'utf8') <= SCENE_SVG_MAX_BYTES, {
      message: 'svg too large',
    })
    .optional(),
});
