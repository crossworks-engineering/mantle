/**
 * Who is on the other end of a tool call (client logins C4, plan section 8).
 *
 * Before C4 the owner-only tools refused `surface.kind === 'team'` and let
 * every other value through, so a new kind (client) or a caller that forgot
 * its surface was treated as the owner. The check is now an ALLOWLIST: only
 * the owner's own surfaces pass. A missing surface is not the owner (review
 * 1 R15, review 2 N15): every owner path names itself (web, telegram, or
 * `{ kind: 'owner', via }`).
 */
import type { ToolHandlerContext } from './types';

export type ToolSurface = NonNullable<ToolHandlerContext['surface']>;

/** Whether the caller is the brain's owner: their web or Telegram chat, or
 *  an owner path that says so. Team, client and a missing surface are not. */
export function isOwnerSurface(surface: ToolHandlerContext['surface']): boolean {
  const kind = surface?.kind;
  return kind === 'web' || kind === 'telegram' || kind === 'owner';
}

/** The refusal an owner-only tool returns to anyone else. */
export const OWNER_ONLY_ERROR =
  'owner-side tool: not available here (it runs only for the brain owner).';
