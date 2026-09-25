/**
 * Setting levels (member logins Phase 0b, plan section 2c). One level system:
 * admin > team > client > public, on brain items, agents and tool groups.
 * Default admin; lowered only by an admin, by hand, through these functions.
 *
 * Rules enforced here (the database enforces them again):
 *  - Only workspace kinds may go below admin (the type ceiling): journal,
 *    email, contacts, secrets, tasks, events and every other kind are admin
 *    forever.
 *  - No inheritance. Lowering an item offers its CLOSURE (what its share or
 *    its embeds need to keep working: a page's embedded files and drawings, a
 *    folder's contents, a drawing's images) as one explicit extra step.
 *    The closure is only ever LOWERED, never raised.
 *  - An agent may hold only tool groups at or below its level, checked when
 *    either level changes (and at grant time, see agentGrantProblems).
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  agents,
  db,
  draws,
  isViewerLevel,
  lowerLevel,
  nodes,
  toolGroups,
  WORKSPACE_NODE_TYPES,
  type ViewerLevel,
} from '@mantle/db';
import { referencedDrawIds, referencedFileIds } from './doc-assets';
import { getPage } from './pages/read';

export type AccessItem = { id: string; type: string; title: string; audience: ViewerLevel };

const WORKSPACE = new Set<string>(WORKSPACE_NODE_TYPES);

/** Whether a node type may go below admin. */
export function isWorkspaceKind(type: string): boolean {
  return WORKSPACE.has(type);
}

function asLevel(v: string): ViewerLevel {
  return isViewerLevel(v) ? v : 'admin';
}

/** Rank helper: is `a` strictly above `b`? */
function isAbove(a: ViewerLevel, b: ViewerLevel): boolean {
  return lowerLevel(a, b) === b && a !== b;
}

/**
 * The items an item's share or embeds need, beyond itself: a page's embedded
 * files and drawings, a folder's workspace contents (recursive), a drawing's
 * images. Workspace kinds only (anything else cannot go below admin).
 */
export async function accessClosure(ownerId: string, nodeId: string): Promise<AccessItem[]> {
  const [root] = await db
    .select({ id: nodes.id, type: nodes.type, path: nodes.path })
    .from(nodes)
    .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)))
    .limit(1);
  if (!root) return [];

  let ids: string[] = [];
  if (root.type === 'page') {
    const page = await getPage(ownerId, nodeId);
    if (page) ids = [...referencedFileIds(page.doc), ...referencedDrawIds(page.doc)];
  } else if (root.type === 'draw') {
    const [d] = await db
      .select({ fileRefs: draws.fileRefs })
      .from(draws)
      .where(eq(draws.nodeId, nodeId))
      .limit(1);
    ids = Object.values(d?.fileRefs ?? {});
  } else if (root.type === 'branch') {
    const rows = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          sql`${nodes.path} <@ ${root.path}::ltree`,
          sql`${nodes.id} <> ${nodeId}`,
        ),
      );
    ids = rows.map((r) => r.id);
  }
  ids = [...new Set(ids)].filter((id) => id !== nodeId);
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
  /** Closure items lowered with it (only when asked). */
  lowered: AccessItem[];
  /** Closure items still ABOVE the new level (not asked, or asked = false):
   *  the share or embeds that need them will not show them at this level. */
  stillAbove: AccessItem[];
};

/**
 * Set a brain item's level. `withClosure` also lowers the closure items that
 * sit above the new level (never raises any). Refuses a non-workspace kind
 * below admin.
 */
export async function setItemAudience(
  ownerId: string,
  nodeId: string,
  audience: string,
  opts: { withClosure?: boolean } = {},
): Promise<SetItemAudienceResult> {
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

  const closure = audience === 'admin' ? [] : await accessClosure(ownerId, nodeId);
  const above = closure.filter((c) => isAbove(c.audience, audience));
  return db.transaction(async (tx) => {
    await tx
      .update(nodes)
      .set({ audience })
      .where(and(eq(nodes.id, nodeId), eq(nodes.ownerId, ownerId)));
    let lowered: AccessItem[] = [];
    if (opts.withClosure && above.length > 0) {
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
    return {
      item: { id: row.id, type: row.type, title: row.title, audience },
      lowered,
      stillAbove: opts.withClosure ? [] : above,
    };
  });
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
  return rows
    .map((r) => ({ slug: r.slug, audience: asLevel(r.audience) }))
    .filter((r) => isAbove(r.audience, level));
}

/**
 * Why an agent at `level` may not hold `groupSlugs` (empty = fine). Used when
 * an agent's level is lowered and when a group is granted to it.
 */
export async function agentGrantProblems(
  ownerId: string,
  level: ViewerLevel,
  groupSlugs: readonly string[],
): Promise<string[]> {
  const above = await groupsAbove(ownerId, groupSlugs, level);
  return above.map(
    (g) => `tool group '${g.slug}' is ${g.audience}-level; a ${level}-level agent cannot hold it`,
  );
}

/** Set an agent's level. Refuses when it holds a tool group above the new
 *  level: remove the group first (plan 2c). */
export async function setAgentAudience(
  ownerId: string,
  agentId: string,
  audience: string,
): Promise<{ id: string; slug: string; audience: ViewerLevel }> {
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
  const problems = await agentGrantProblems(ownerId, audience, agent.groups ?? []);
  if (problems.length > 0) {
    throw new AccessError(problems.join('; '), 'group_above_agent');
  }
  await db
    .update(agents)
    .set({ audience })
    .where(and(eq(agents.id, agentId), eq(agents.ownerId, ownerId)));
  return { id: agent.id, slug: agent.slug, audience };
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
  const lowerHolders = holders.filter((a) => isAbove(audience, asLevel(a.audience)));
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
