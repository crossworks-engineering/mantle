/**
 * The access shadow report (member logins Phase 0b, plan 11a gap 3): what the
 * team responder would LOSE if it ran at team level today. Read it before
 * lowering `team-responder` to team (the one switch), fix what it lists, then
 * lower. Offline and read-only: it reads recorded traces and current levels,
 * spends no LLM call, writes nothing.
 *
 * It lists:
 *  - usedAtAdmin: items recent team/forum turns actually used (retrieval
 *    snapshot hits and passages, node ids the tools were asked for) that are
 *    still admin, so a team-level turn would not see them;
 *  - sharedAtCeiling: items with an active share that can never go below
 *    admin (a shared task or event): members lose them under enforcement;
 *  - closureGaps: items below admin whose closure (embeds, folder contents)
 *    is still above them, so their share or embeds would break;
 *  - facts: how many current facts a team-level turn could still use;
 *  - agent: the responder's own level and any granted group above team.
 */
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { agents, db, facts, nodes, shares, toolGroups, traces, traceSteps } from '@mantle/db';
import { accessClosure, isWorkspaceKind, type AccessItem } from './access';

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export type ShadowItem = { id: string; type: string; title: string; uses: number };

export type AccessShadowReport = {
  windowDays: number;
  turns: number;
  usedAtAdmin: ShadowItem[];
  sharedAtCeiling: { id: string; type: string; title: string; mode: string }[];
  closureGaps: { id: string; title: string; audience: string; above: AccessItem[] }[];
  facts: { current: number; withVisibleSource: number };
  agent: { slug: string; audience: string; groupsAboveTeam: string[] } | null;
};

type SnapshotLike = {
  snapshot?: {
    contentHits?: { sent?: { nodeId?: string | null }[] };
    chunkHits?: { sent?: { nodeId?: string | null }[] };
  };
};

/** Node ids a recorded turn used: snapshot hits and passages, plus any id a
 *  tool was called with. Pure, so the extraction is unit-tested. */
export function idsUsedByStep(step: { name: string; input: unknown; output: unknown }): string[] {
  const out: string[] = [];
  if (step.name === 'load_context') {
    const snap = (step.output as SnapshotLike | null)?.snapshot;
    for (const item of [...(snap?.contentHits?.sent ?? []), ...(snap?.chunkHits?.sent ?? [])]) {
      if (item.nodeId) out.push(item.nodeId);
    }
  } else if (step.name.startsWith('tool: ')) {
    out.push(...(JSON.stringify(step.input ?? {}).match(UUID_G) ?? []));
  }
  return out;
}

export async function accessShadowReport(
  ownerId: string,
  opts: { days?: number; agentSlug?: string } = {},
): Promise<AccessShadowReport> {
  const days = opts.days ?? 30;
  const agentSlug = opts.agentSlug ?? 'team-responder';
  const since = new Date(Date.now() - days * 86_400_000);

  // ── What recent member turns used ─────────────────────────────────────────
  const turnRows = await db
    .select({ id: traces.id })
    .from(traces)
    .where(
      and(
        eq(traces.ownerId, ownerId),
        eq(traces.kind, 'responder_turn'),
        gt(traces.startedAt, since),
        sql`${traces.data}->>'surface' in ('team', 'forum')`,
      ),
    );
  const uses = new Map<string, number>();
  if (turnRows.length > 0) {
    const steps = await db
      .select({ name: traceSteps.name, input: traceSteps.input, output: traceSteps.output })
      .from(traceSteps)
      .where(
        and(
          inArray(
            traceSteps.traceId,
            turnRows.map((t) => t.id),
          ),
          or(eq(traceSteps.name, 'load_context'), sql`${traceSteps.name} like 'tool: %'`),
        ),
      );
    for (const s of steps) for (const id of idsUsedByStep(s)) uses.set(id, (uses.get(id) ?? 0) + 1);
  }
  let usedAtAdmin: ShadowItem[] = [];
  if (uses.size > 0) {
    const rows = await db
      .select({ id: nodes.id, type: nodes.type, title: nodes.title })
      .from(nodes)
      .where(
        and(
          eq(nodes.ownerId, ownerId),
          eq(nodes.audience, 'admin'),
          inArray(nodes.id, [...uses.keys()]),
        ),
      );
    usedAtAdmin = rows
      .map((r) => ({ ...r, uses: uses.get(r.id) ?? 0 }))
      .sort((a, b) => b.uses - a.uses);
  }

  // ── Active shares ──────────────────────────────────────────────────────────
  const shared = await db
    .select({
      id: nodes.id,
      type: nodes.type,
      title: nodes.title,
      audience: nodes.audience,
      mode: sql<string>`coalesce(${shares.settings}->>'mode', 'public')`,
    })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(
      and(
        eq(shares.ownerId, ownerId),
        isNull(shares.revokedAt),
        or(isNull(shares.expiresAt), gt(shares.expiresAt, new Date())),
      ),
    );
  const sharedAtCeiling = shared
    .filter((s) => !isWorkspaceKind(s.type))
    .map(({ id, type, title, mode }) => ({ id, type, title, mode }));

  // ── Closure gaps for items below admin that are shared ────────────────────
  const closureGaps: AccessShadowReport['closureGaps'] = [];
  const LEVEL_RANK: Record<string, number> = { public: 0, client: 1, team: 2, admin: 3 };
  for (const s of shared) {
    if (s.audience === 'admin' || !isWorkspaceKind(s.type)) continue;
    const above = (await accessClosure(ownerId, s.id)).filter(
      (c) => (LEVEL_RANK[c.audience] ?? 3) > (LEVEL_RANK[s.audience] ?? 3),
    );
    if (above.length > 0)
      closureGaps.push({ id: s.id, title: s.title, audience: s.audience, above });
  }

  // ── Facts a team-level turn could still use ───────────────────────────────
  const [factCounts] = await db
    .select({
      current: sql<number>`count(*)::int`,
      withVisibleSource: sql<number>`count(*) filter (where exists (
        select 1 from ${nodes} src where src.id = ${facts.sourceNodeId}
          and src.audience <> 'admin' and mantle_workspace_kind(src.type)))::int`,
    })
    .from(facts)
    .where(and(eq(facts.ownerId, ownerId), isNull(facts.validTo)));

  // ── The responder itself ──────────────────────────────────────────────────
  const [agent] = await db
    .select({ slug: agents.slug, audience: agents.audience, groups: agents.toolGroupSlugs })
    .from(agents)
    .where(and(eq(agents.ownerId, ownerId), eq(agents.slug, agentSlug)))
    .limit(1);
  let agentOut: AccessShadowReport['agent'] = null;
  if (agent) {
    const groups = agent.groups ?? [];
    const above =
      groups.length === 0
        ? []
        : await db
            .select({ slug: toolGroups.slug })
            .from(toolGroups)
            .where(
              and(
                eq(toolGroups.ownerId, ownerId),
                inArray(toolGroups.slug, groups),
                eq(toolGroups.audience, 'admin'),
              ),
            );
    agentOut = {
      slug: agent.slug,
      audience: agent.audience,
      groupsAboveTeam: above.map((g) => g.slug),
    };
  }

  return {
    windowDays: days,
    turns: turnRows.length,
    usedAtAdmin,
    sharedAtCeiling,
    closureGaps,
    facts: {
      current: factCounts?.current ?? 0,
      withVisibleSource: factCounts?.withVisibleSource ?? 0,
    },
    agent: agentOut,
  };
}
