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

/** Whether the caller is on an owner-side surface: a web or Telegram chat,
 *  or an owner path that says so. Team, client and a missing surface are
 *  not. Since workspaces W7d a Telegram chat is its paired user's, in the
 *  workspace of the bot's assistant: what an owner-only or Admin-area tool
 *  may do there is the turn scope's to decide (admin-gate.ts), as for a web
 *  chat. */
export function isOwnerSurface(surface: ToolHandlerContext['surface']): boolean {
  const kind = surface?.kind;
  return kind === 'web' || kind === 'telegram' || kind === 'owner';
}

/** The login an owner surface names (its web chat's signed-in login, an MCP
 *  connection's or an API key's, a Telegram chat's paired login since W7d),
 *  or null when the path names none (W6b fix round 2, M-2). Never read from
 *  model arguments. */
export function ownerSurfaceLoginId(surface: ToolHandlerContext['surface']): string | null {
  if (surface?.kind !== 'web' && surface?.kind !== 'owner' && surface?.kind !== 'telegram') {
    return null;
  }
  return typeof surface.loginId === 'string' && surface.loginId !== '' ? surface.loginId : null;
}

/** The refusal an owner-only tool returns to anyone else. */
export const OWNER_ONLY_ERROR =
  'owner-side tool: not available here (it runs only for the brain owner).';

/** The end of the refusal a key or a peer gets for a change that opens a
 *  tool below admin (access matrix T9). */
export const OPENS_ADMIN_ONLY =
  "an API key or a linked brain cannot do: only an admin, in Settings or from the owner's own MCP client.";

/** An API key or a peer acting as the owner (access matrix T9). */
export function keyOrPeerVia(
  ctx: Pick<ToolHandlerContext, 'surface'>,
): 'api' | 'federation' | null {
  const s = ctx.surface;
  return s?.kind === 'owner' && (s.via === 'api' || s.via === 'federation') ? s.via : null;
}

/** Whether this call is a direct MCP, key or peer call of a login outside
 *  an Admin scope (W7b fix round 2, M-a), or an approved call asked on one
 *  (the approval's surface keeps it, lows round 2, L6): it spends nothing
 *  on the brain owner's provider keys, so a tool skips its paid step. A
 *  workspace assistant's turn carries no MCP channel and keeps its own
 *  rules. */
export function ownerKeysOff(ctx: Pick<ToolHandlerContext, 'surface'>): boolean {
  const s = ctx.surface;
  return s?.kind === 'owner' && (s.mcp?.ownerKeysOff === true || s.ownerKeysOff === true);
}
