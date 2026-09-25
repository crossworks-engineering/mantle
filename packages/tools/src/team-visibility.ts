/**
 * What a team-member surface may see. Team chat, the forum and a team-mode
 * shared app all run tools under the OWNER's id, so without this filter every
 * read tool reaches the owner's email, journal, secrets and Telegram chats.
 *
 * Fail closed: a team or forum surface with no `privateReads` flag hides the
 * private corpus too. Owner surfaces (web, telegram, background) get null and
 * are not filtered.
 */
import { teamHiddenNodeTypes } from '@mantle/content-core/profile-projections';
import type { ToolHandlerContext } from './types';

export function surfaceHiddenNodeTypes(
  surface: ToolHandlerContext['surface'],
): readonly string[] | null {
  if (surface?.kind === 'team' || surface?.kind === 'forum') {
    return teamHiddenNodeTypes(surface.privateReads === true);
  }
  return null;
}

/** The refusal a read tool returns when a team surface asks for a hidden
 *  node by id. Worded as "not found" so it does not confirm the node exists. */
export const HIDDEN_NODE_ERROR =
  'node not found — the id may be stale or mistyped; find it with search_nodes / tree_list, then re-issue.';
