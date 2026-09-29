/**
 * What a team-member surface may see. A member's chat and a team-mode
 * shared app all run tools under the OWNER's id, so without this filter every
 * read tool reaches the owner's email, journal, secrets and Telegram chats.
 *
 * Fail closed: a team surface with no `privateReads` flag hides the
 * private corpus too. Only owner surfaces (web, telegram, `owner`) get null
 * and are not filtered; a client or a MISSING surface gets the full hidden
 * list (client logins C4: a caller that forgot its surface is not the owner).
 */
import { teamHiddenNodeTypes } from '@mantle/content-core/profile-projections';
import type { ToolHandlerContext } from './types';
import { isOwnerSurface } from './surface';

export function surfaceHiddenNodeTypes(
  surface: ToolHandlerContext['surface'],
): readonly string[] | null {
  if (isOwnerSurface(surface)) return null;
  if (surface?.kind === 'team') {
    return teamHiddenNodeTypes(surface.privateReads === true);
  }
  return teamHiddenNodeTypes(false);
}

/** The refusal a read tool returns when a team surface asks for a hidden
 *  node by id. Worded as "not found" so it does not confirm the node exists. */
export const HIDDEN_NODE_ERROR =
  'node not found — the id may be stale or mistyped; find it with search_nodes / tree_list, then re-issue.';
