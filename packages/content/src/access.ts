/**
 * Setting levels (member logins Phase 0b, plan section 2c). One level system:
 * admin > team > client > public, on brain items, agents and tool groups.
 * Default admin; lowered only by an admin, by hand, through these functions.
 *
 * Rules enforced here (the database enforces them again):
 *  - Only workspace kinds may go below admin (the type ceiling): journal,
 *    email, contacts, secrets, tasks, events and every other kind are admin
 *    forever.
 *  - Embedding means sharing (audit F19 follow-up). Lowering an item is an
 *    admin's decision for the item AND what it embeds: a page's images, file
 *    embeds, drawings and child pages, a drawing's images, a note's images
 *    (embed-closure.ts) go down with it, in the same transaction, and come
 *    back in `alsoLowered`. Nothing is raised, and an embed already at or
 *    below the level is left alone.
 *  - A folder's contents do not follow it (folder links show only their
 *    level, audit F19): "Lower them too" (`withClosure`) stays one explicit
 *    extra step for a folder. Raising an item offers the mirror step: closure
 *    items still BELOW it (a folder taken back to admin whose files stay at
 *    team, a page's images left public) can be raised with it
 *    (`raiseClosure`). Lowering never raises and raising never lowers.
 *  - An agent may hold only tool groups at or below its level, checked when
 *    either level changes (and at grant time, see agentGrantProblems).
 *    Lowering an agent that holds a group above the new level is refused,
 *    unless the caller asks for those groups to leave it with the change
 *    (`dropGroupsAbove`).
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  agents,
  db,
  isViewerLevel,
  itemLevelAbove,
  levelCovers,
  nodes,
  shares,
  toolGroups,
  WORKSPACE_NODE_TYPES,
  type ViewerLevel,
} from '@mantle/db';
import {
  EMBEDDING_KINDS,
  embedClosure,
  lowerEmbedClosure,
  type EmbedItem,
  type LoweredItem,
} from './embed-closure';
import { refoldPageTexts } from './pages/level-text';
import {
  applyLevelToShare,
  getActiveShareForNode,
  revokeShareTree,
  type ShareDb,
  type ShareSummary,
} from './shares';

export type AccessItem = { id: string; type: string; title: string; audience: ViewerLevel };

const WORKSPACE = new Set<string>(WORKSPACE_NODE_TYPES);

/** Whether a node type may go below admin. */
export function isWorkspaceKind(type: string): boolean {
  return WORKSPACE.has(type);
}

function asLevel(v: string): ViewerLevel {
  return isViewerLevel(v) ? v : 'admin';
}

/** Rank helper: is `a` strictly above `b`? The item rank (admin > team >
 *  client > public), not what a viewer reads (lowerLevel refuses client
 *  with public). */
function isAbove(a: ViewerLevel, b: ViewerLevel): boolean {
  return itemLevelAbove(a, b);
}

/**
 * The items an item's share or embeds need, beyond itself: for a page,
 * drawing or note its embed closure (embed-closure.ts: images, file embeds,
 * drawings and child pages, transitively), which follows the item down; for
 * a folder its workspace contents (recursive), which do not. Workspace kinds
 * only (anything else cannot go below admin).
 */
export async function accessClosure(ownerId: string, nodeId: string): Promise<AccessItem[]> {
  const [root] = await db
    .select({ id: nodes.id, type: nodes.type, path: nodes.path })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!root) return [];

  if (EMBEDDING_KINDS.includes(root.type)) {
    return (await embedClosure(ownerId, nodeId))
      .filter((r) => isWorkspaceKind(r.type))
      .map(({ id, type, title, audience }) => ({ id, type, title, audience }));
  }
  if (root.type !== 'branch') return [];
  const contents = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        sql`${nodes.path} <@ ${root.path}::ltree`,
        sql`${nodes.id} <> ${nodeId}`,
      ),
    );
  const ids = [...new Set(contents.map((r) => r.id))];
  if (ids.length === 0) return [];

  const rows = await db
    .select({ id: nodes.id, type: nodes.type, title: nodes.title, audience: nodes.audience })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, ids)));
  return rows
    .filter((r) => isWorkspaceKind(r.type))
    .map((r) => ({ id: r.id, type: r.type, title: r.title, audience: asLevel(r.audience) }));
}

export class AccessError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'type_ceiling' | 'invalid_level' | 'group_above_agent',
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

export type SetItemAudienceResult = {
  item: AccessItem;
  /** Everything lowered with it, at its new level: the embeds that followed
   *  it (always) and a folder's contents (only when `withClosure`). The
   *  Access control reads this to refresh the screens they live on. */
  lowered: AccessItem[];
  /** The embeds that followed the item down, with the level each left and
   *  took (embedding means sharing). Empty when the item went to admin. */
  alsoLowered: LoweredItem[];
  /** Closure items still ABOVE the new level: an embed that can never go
   *  below admin (the type ceiling), or a folder's contents when not asked.
   *  People at the item's level will not see them. */
  stillAbove: AccessItem[];
  /** Closure items raised with it (only when `raiseClosure`). */
  raised: AccessItem[];
  /** Closure items still BELOW the new level (not asked): people at their
   *  level can still open them although the item itself went up. */
  stillBelow: AccessItem[];
};

/** What setting a level will do, read before any write: the item and the
 *  closure items above and below the new level. */
type AudiencePlan = {
  item: AccessItem;
  above: AccessItem[];
  below: AccessItem[];
};

/** Validate a level change and read the closure (on the pool, never inside
 *  a transaction: a transaction waiting on a second pool connection can
 *  starve the pool). */
async function planItemAudience(
  ownerId: string,
  nodeId: string,
  audience: string,
): Promise<AudiencePlan> {
  if (!isViewerLevel(audience)) {
    throw new AccessError(
      `'${audience}' is not a level: use admin, team, client or public`,
      'invalid_level',
    );
  }
  const [row] = await db
    .select({ id: nodes.id, type: nodes.type, title: nodes.title })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!row) throw new AccessError(`item ${nodeId} not found`, 'not_found');
  if (audience !== 'admin' && !isWorkspaceKind(row.type)) {
    throw new AccessError(
      `a ${row.type} is admin only: only pages, notes, drawings, tables, files, folders, apps and formulas can go below admin`,
      'type_ceiling',
    );
  }

  const closure = await accessClosure(ownerId, nodeId);
  return {
    item: { id: row.id, type: row.type, title: row.title, audience },
    above: closure.filter((c) => isAbove(c.audience, audience)),
    below: closure.filter((c) => isAbove(audience, c.audience)),
  };
}

/** Write a planned level change through `q`: the item, its embeds (always,
 *  when it goes below admin), a folder's contents or the closure below it
 *  (when asked). */
async function applyItemAudience(
  ownerId: string,
  plan: AudiencePlan,
  opts: { withClosure?: boolean; raiseClosure?: boolean },
  q: ShareDb,
): Promise<SetItemAudienceResult> {
  const { item, above, below } = plan;
  const audience = item.audience;
  return q.transaction(async (tx) => {
    await tx
      .update(nodes)
      .set({ audience })
      .where(and(eq(nodes.id, item.id), eq(nodes.ownerId, ownerId)));
    // Embedding means sharing: what the item embeds goes down with it, walked
    // again inside this transaction (the plan's read was only a preview).
    const embeds = EMBEDDING_KINDS.includes(item.type);
    let alsoLowered: LoweredItem[] = [];
    let ceiling: EmbedItem[] = [];
    if (embeds && audience !== 'admin') {
      ({ lowered: alsoLowered, ceiling } = await lowerEmbedClosure(ownerId, item.id, audience, tx));
    }
    let lowered: AccessItem[] = alsoLowered.map(({ id, type, title, to }) => ({
      id,
      type,
      title,
      audience: to,
    }));
    if (!embeds && opts.withClosure && above.length > 0) {
      await tx
        .update(nodes)
        .set({ audience })
        .where(
          and(
            eq(nodes.ownerId, ownerId),
            inArray(
              nodes.id,
              above.map((a) => a.id),
            ),
          ),
        );
      lowered = above.map((a) => ({ ...a, audience }));
    }
    // Still above: for an embedding kind, the embeds the type ceiling keeps at
    // admin; for a folder, its contents when not asked.
    const stillAbove: AccessItem[] = embeds
      ? audience === 'admin'
        ? []
        : ceiling.map(({ id, type, title, audience: a }) => ({ id, type, title, audience: a }))
      : opts.withClosure
        ? []
        : above;
    let raised: AccessItem[] = [];
    if (opts.raiseClosure && below.length > 0) {
      await tx
        .update(nodes)
        .set({ audience })
        .where(
          and(
            eq(nodes.ownerId, ownerId),
            inArray(
              nodes.id,
              below.map((b) => b.id),
            ),
          ),
        );
      raised = below.map((b) => ({ ...b, audience }));
    }
    // The indexed text follows the levels (pages/level-text.ts, SQL only):
    // the item's own, and of every client or public page naming an item that
    // moved here. The embeds that followed it were re-folded as they went.
    await refoldPageTexts(
      ownerId,
      [item.id, ...(embeds ? [] : lowered.map((l) => l.id)), ...raised.map((r) => r.id)],
      tx,
    );
    return {
      item,
      lowered,
      alsoLowered,
      stillAbove,
      raised,
      stillBelow: opts.raiseClosure ? [] : below,
    };
  });
}

/**
 * Set a brain item's level. Below admin, what a page, drawing or note embeds
 * goes down with it (`alsoLowered`). `withClosure` also lowers a folder's
 * contents that sit above the new level (a folder's contents never follow it
 * on their own); `raiseClosure` also raises the closure items below it. The
 * two are separate on purpose: lowering can never raise anything.
 * Refuses a non-workspace kind below admin.
 */
export async function setItemAudience(
  ownerId: string,
  nodeId: string,
  audience: string,
  opts: { withClosure?: boolean; raiseClosure?: boolean } = {},
): Promise<SetItemAudienceResult> {
  return applyItemAudience(ownerId, await planItemAudience(ownerId, nodeId, audience), opts, db);
}

export type SetItemLevelResult = SetItemAudienceResult & {
  /** The item's link after the change: an open link at public, null at
   *  admin and team (revoked) and at client, except an item already at
   *  client keeps its old link row (client logins C1; since C3 the public
   *  read path never serves it). */
  share: ShareSummary | null;
};

/**
 * The owner's one lever on an item: set its level, then make its link match
 * (levels drive links, docs/access-levels.md §7). Closure items only get the
 * level, never a link of their own: they are reached through the item. Level
 * and link change in ONE transaction: a link that cannot be made leaves the
 * level where it was, not an item at public with no link.
 */
export async function setItemLevel(
  ownerId: string,
  nodeId: string,
  audience: string,
  opts: { withClosure?: boolean; raiseClosure?: boolean } = {},
): Promise<SetItemLevelResult> {
  const plan = await planItemAudience(ownerId, nodeId, audience);
  return db.transaction(async (tx) => {
    // The level before the change, read under a row lock: another writer
    // cannot move it between this read and the write below.
    const [before] = await tx
      .select({ audience: nodes.audience })
      .from(nodes)
      .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
      .for('update')
      .limit(1);
    const res = await applyItemAudience(ownerId, plan, opts, tx);
    // Client to client ("Lower them too", "Raise them too", access_set
    // client on a client item) leaves the item's own link alone: an old
    // client link lives until the old links are retired (client logins C3),
    // and setting the level it already has is no reason to break it.
    const keepLink = before?.audience === 'client' && res.item.audience === 'client';
    const share = keepLink
      ? await getActiveShareForNode(ownerId, nodeId, tx)
      : await applyLevelToShare(ownerId, nodeId, res.item.audience, tx);
    // A raised closure item that carries a link of its OWN (a file shared on
    // its own, say) must have that link follow it, or level and link drift: an
    // open link on an item now at admin. Items without a link get none.
    for (const r of res.raised) {
      if (await getActiveShareForNode(ownerId, r.id, tx)) {
        await applyLevelToShare(ownerId, r.id, r.audience, tx);
      }
    }
    return { ...res, share };
  });
}

export type UnshareItemResult = {
  /** Whether a live link was revoked (false: already gone or not found). */
  revoked: boolean;
  /** Closure items still BELOW admin after the unshare (a page's embedded
   *  files at client, say): the link is gone but people at their level can
   *  still open them. Raise them with the Access control or `access_set`
   *  (`raiseClosure`). */
  stillBelow: AccessItem[];
};

/**
 * Turn an item's link off (the share DELETE route, `node_unshare`,
 * `page_unshare`). Removing an open link is setting the item to admin by
 * hand, with the same closure rule: what it embeds is reported, never raised
 * on its own. A client item's old link is revoked and the item stays at
 * client (client logins C1). Revokes by share id first so an expired link is retired too.
 * (Team links, which left their item at team, are retired: member logins
 * Phase 6 stage 6.)
 */
export async function unshareItem(ownerId: string, shareId: string): Promise<UnshareItemResult> {
  const [row] = await db
    .select({ nodeId: shares.nodeId, contactId: shares.contactId })
    .from(shares)
    .where(and(eq(shares.id, shareId), eq(shares.ownerId, ownerId), isNull(shares.revokedAt)))
    .limit(1);
  const revoked = await revokeShareTree(ownerId, shareId);
  if (!row) return { revoked, stillBelow: [] };
  // A contact share (0214) never set a level, so removing one changes none:
  // the item stays where the admin put it.
  if (row.contactId) return { revoked, stillBelow: [] };
  // A client item keeps its level (client logins C1): its old link is gone,
  // and client means signed-in clients, which no link decides.
  const [node] = await db
    .select({ audience: nodes.audience })
    .from(nodes)
    .where(and(eq(nodes.id, row.nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (node?.audience === 'client') return { revoked, stillBelow: [] };
  const res = await setItemLevel(ownerId, row.nodeId, 'admin');
  return { revoked, stillBelow: res.stillBelow };
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
 * Set an agent's level. Refuses when it holds a tool group above the new
 * level (plan 2c), and the refusal names the fix. `dropGroupsAbove` is that
 * fix in the same call: the groups above the new level leave the agent with
 * the change and come back in `removedGroups` (team-responder going to team
 * leaves `team-read-admin` behind). It is opt-in, never the default: a wrong
 * slug must not strip an agent of its groups (the persona holds only admin
 * groups), and raising the level again does not bring them back.
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
    .select({ id: agents.id, slug: agents.slug, groups: agents.toolGroupSlugs })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)))
    .limit(1);
  if (!agent) throw new AccessError(`agent ${agentId} not found`, 'not_found');
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
  return { id: agent.id, slug: agent.slug, audience, removedGroups };
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
