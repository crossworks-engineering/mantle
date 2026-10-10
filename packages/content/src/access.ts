/**
 * Agent and tool-group levels (member logins Phase 0b, plan section 2c):
 * admin > team > client > public. They stay until workspaces W7 (contract
 * change 21). Brain items have no level any more (workspaces W5b2): who
 * reads an item is its grants (Grant Access), and the item level engine that
 * lived here is gone.
 *
 * The rule enforced here: an agent may hold only tool groups at or below its
 * level, checked when either level changes (and at grant time, see
 * agentGrantProblems). Lowering an agent that holds a group above the new
 * level is refused, unless the caller asks for those groups to leave it with
 * the change (`dropGroupsAbove`).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  agents,
  channels,
  db,
  isViewerLevel,
  levelCovers,
  telegramChats,
  toolGroups,
  WORKSPACE_NODE_TYPES,
  type ViewerLevel,
} from '@mantle/db';
import { revokeShareTree } from './shares';

const WORKSPACE = new Set<string>(WORKSPACE_NODE_TYPES);

/** Whether a node type may live in a workspace other than Admin. */
export function isWorkspaceKind(type: string): boolean {
  return WORKSPACE.has(type);
}

function asLevel(v: string): ViewerLevel {
  return isViewerLevel(v) ? v : 'admin';
}

export class AccessError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'type_ceiling'
      | 'invalid_level'
      | 'group_above_agent'
      | 'telegram_paired'
      | 'agent_in_workspace',
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

export type UnshareItemResult = {
  /** Whether a live link or contact share was revoked (false: already gone
   *  or not found). */
  revoked: boolean;
};

/**
 * Turn an item's link or contact share off (the share DELETE route,
 * `node_unshare`, `page_unshare`): a plain revoke. Who reads the item is its
 * grants, which a link never changed since workspaces W5b2. Revokes by share
 * id, so an expired link is retired too.
 */
export async function unshareItem(ownerId: string, shareId: string): Promise<UnshareItemResult> {
  return { revoked: await revokeShareTree(ownerId, shareId) };
}

/** The tool groups an agent holds that sit ABOVE `level`. */
async function groupsAbove(
  ownerId: string,
  groupSlugs: readonly string[],
  level: ViewerLevel,
): Promise<{ slug: string; audience: ViewerLevel }[]> {
  if (groupSlugs.length === 0 || level === 'admin') return [];
  const rows = await db
    .select({ slug: toolGroups.slug, audience: toolGroups.audience })
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), inArray(toolGroups.slug, [...groupSlugs])));
  return (
    rows
      .map((r) => ({ slug: r.slug, audience: asLevel(r.audience) }))
      // An agent holds a group only when its level READS that group's level:
      // a client agent cannot hold a public group (client and public are
      // siblings since 0187), nor a public agent a client group.
      .filter((r) => !levelCovers(level, r.audience))
  );
}

const grantProblem = (g: { slug: string; audience: ViewerLevel }, level: ViewerLevel) =>
  `tool group '${g.slug}' is ${g.audience}-level; a ${level}-level agent cannot hold it`;

/**
 * Why an agent at `level` may not hold `groupSlugs` (empty = fine). Used when
 * an agent's level is lowered and when a group is granted to it.
 */
export async function agentGrantProblems(
  ownerId: string,
  level: ViewerLevel,
  groupSlugs: readonly string[],
): Promise<string[]> {
  return (await groupsAbove(ownerId, groupSlugs, level)).map((g) => grantProblem(g, level));
}

/** How the caller asks for `dropGroupsAbove`, named in the refusal so the
 *  admin reads the exact fix (the API body field, then the tool input). */
const DROP_GROUPS_HINT = '`dropGroupsAbove: true` (access_set: `drop_groups_above: true`)';

/**
 * Refuse to lower an agent that is on Telegram (access matrix T21, option
 * 3): a paired Telegram chat acts as the owner, so only an admin-level agent
 * keeps a bot or answers a paired chat. The bot is the enabled telegram
 * channel (a disconnected one is disabled and polls nothing); a paired chat
 * is an allowed one pinned to this agent. The turn refuses a below-admin
 * agent anyway; this keeps the owner from building the state at all, and the
 * refusal names the fix.
 */
async function refuseIfOnTelegram(
  ownerId: string,
  agentId: string,
  slug: string,
  audience: ViewerLevel,
): Promise<void> {
  const [bot] = await db
    .select({ name: channels.displayName })
    .from(channels)
    .where(
      and(
        eq(channels.ownerId, ownerId),
        eq(channels.agentId, agentId),
        eq(channels.type, 'telegram'),
        eq(channels.enabled, true),
      ),
    )
    .limit(1);
  const why =
    `a ${audience}-level agent cannot be on Telegram, because a paired Telegram chat ` +
    'acts as the owner';
  if (bot) {
    throw new AccessError(
      `agent '${slug}' has a Telegram bot (${bot.name}), and ${why}. ` +
        `Disconnect the bot first (Settings > Agents > ${slug} > Telegram bot), then set the level`,
      'telegram_paired',
    );
  }
  const pinned = await db
    .select({ id: telegramChats.id })
    .from(telegramChats)
    .where(
      and(
        eq(telegramChats.userId, ownerId),
        eq(telegramChats.responderAgentId, agentId),
        eq(telegramChats.allowlistStatus, 'allowed'),
      ),
    );
  if (pinned.length > 0) {
    const n = pinned.length;
    throw new AccessError(
      `agent '${slug}' answers ${n} paired Telegram chat${n === 1 ? '' : 's'}, and ${why}. ` +
        `Give ${n === 1 ? 'that chat' : 'those chats'} another agent or block ${n === 1 ? 'it' : 'them'} first, then set the level`,
      'telegram_paired',
    );
  }
}

/**
 * An assistant of a workspace other than Admin answers there, with tools
 * capped at its own level (skills.ts): raising it to admin would carry
 * admin-level tools into that workspace's turns (W5b1 audit L3). Refused
 * while it sits there; take it off, or clone it for Admin.
 */
async function refuseIfWorkspaceAssistant(agent: {
  slug: string;
  workspaceId: string | null;
}): Promise<void> {
  if (!agent.workspaceId) return;
  const [ws] = (await db.execute(
    sql`select is_admin, name from workspaces where id = ${agent.workspaceId}`,
  )) as unknown as Array<{ is_admin: boolean; name: string }>;
  if (ws && !ws.is_admin) {
    throw new AccessError(
      `agent '${agent.slug}' is the assistant of the ${ws.name} workspace, so it cannot be ` +
        'raised to admin: take it off that workspace first, or clone it for Admin',
      'agent_in_workspace',
    );
  }
}

/**
 * Set an agent's level. Refuses when it holds a tool group above the new
 * level (plan 2c), and the refusal names the fix. `dropGroupsAbove` is that
 * fix in the same call: the groups above the new level leave the agent with
 * the change and come back in `removedGroups` (team-responder going to team
 * leaves `team-read-admin` behind). It is opt-in, never the default: a wrong
 * slug must not strip an agent of its groups (the persona holds only admin
 * groups), and raising the level again does not bring them back. Lowering
 * an agent that is on Telegram is refused outright (refuseIfOnTelegram).
 */
export async function setAgentAudience(
  ownerId: string,
  agentId: string,
  audience: string,
  opts: { dropGroupsAbove?: boolean } = {},
): Promise<{ id: string; slug: string; audience: ViewerLevel; removedGroups: string[] }> {
  if (!isViewerLevel(audience)) {
    throw new AccessError(
      `'${audience}' is not a level: use admin, team, client or public`,
      'invalid_level',
    );
  }
  const [agent] = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      groups: agents.toolGroupSlugs,
      workspaceId: agents.workspaceId,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)))
    .limit(1);
  if (!agent) throw new AccessError(`agent ${agentId} not found`, 'not_found');
  if (audience !== 'admin') await refuseIfOnTelegram(ownerId, agent.id, agent.slug, audience);
  else await refuseIfWorkspaceAssistant(agent);
  const held = agent.groups ?? [];
  const aboveRows = await groupsAbove(ownerId, held, audience);
  const above = new Set(aboveRows.map((g) => g.slug));
  if (above.size > 0 && !opts.dropGroupsAbove) {
    const names = [...above].map((s) => `'${s}'`).join(', ');
    throw new AccessError(
      `${aboveRows.map((g) => grantProblem(g, audience)).join('; ')}. ` +
        `Remove ${names} from agent '${agent.slug}' first, ` +
        `or repeat with ${DROP_GROUPS_HINT} to remove ${above.size === 1 ? 'it' : 'them'} with the change`,
      'group_above_agent',
    );
  }
  // In grant order, as held: the order is the front of the cached prompt.
  const removedGroups = held.filter((g) => above.has(g));
  await db
    .update(agents)
    .set({
      audience,
      ...(removedGroups.length > 0 ? { toolGroupSlugs: held.filter((g) => !above.has(g)) } : {}),
    })
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)));
  await attachDefaultAssistants();
  return { id: agent.id, slug: agent.slug, audience, removedGroups };
}

/**
 * Put the default assistants on Admin and Team where they have none and no
 * Moderator took theirs off (0259, 0260): opening the team responder puts it
 * on Team, by whichever path set the level (the route, access_set; W5b1
 * audit L2). Best effort: a busy lock or a brain without workspaces leaves
 * it to the next boot.
 */
async function attachDefaultAssistants(): Promise<void> {
  try {
    await db.execute(sql`select "public"."mantle_ws_attach_assistants"()`);
  } catch (err) {
    console.warn(
      '[access] attaching the default assistants failed; the next boot tries again:',
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * An agent's level by slug, for the screen that changes it (the team agent
 * card on Team > Settings). null when the agent does not exist.
 */
export async function getAgentAccess(
  ownerId: string,
  slug: string,
): Promise<{ slug: string; name: string; audience: ViewerLevel; enabled: boolean } | null> {
  const [agent] = await db
    .select({
      slug: agents.slug,
      name: agents.name,
      audience: agents.audience,
      enabled: agents.enabled,
    })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, slug)))
    .limit(1);
  return agent ? { ...agent, audience: asLevel(agent.audience) } : null;
}

/** Set a tool group's level. Refuses to RAISE it above an agent that holds
 *  it (that agent would then hold a group above its level). */
export async function setToolGroupAudience(
  ownerId: string,
  slug: string,
  audience: string,
): Promise<{ slug: string; audience: ViewerLevel }> {
  if (!isViewerLevel(audience)) {
    throw new AccessError(
      `'${audience}' is not a level: use admin, team, client or public`,
      'invalid_level',
    );
  }
  const [group] = await db
    .select({ slug: toolGroups.slug })
    .from(toolGroups)
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, slug)))
    .limit(1);
  if (!group) throw new AccessError(`tool group '${slug}' not found`, 'not_found');
  const holders = await db
    .select({ slug: agents.slug, audience: agents.audience })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), sql`${slug} = any(${agents.toolGroupSlugs})`));
  const lowerHolders = holders.filter((a) => !levelCovers(asLevel(a.audience), audience));
  if (lowerHolders.length > 0) {
    throw new AccessError(
      lowerHolders
        .map((a) => `agent '${a.slug}' is ${a.audience}-level and holds '${slug}'`)
        .join('; '),
      'group_above_agent',
    );
  }
  await db
    .update(toolGroups)
    .set({ audience })
    .where(and(eq(toolGroups.ownerId, ownerId), eq(toolGroups.slug, slug)));
  return { slug, audience };
}
