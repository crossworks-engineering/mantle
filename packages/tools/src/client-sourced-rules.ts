/**
 * The lowering guard, by TARGET (client logins C5 audit fixes, L2 and I1;
 * docs/client-logins.md section 8).
 *
 * A turn marked client-sourced (client-sourced.ts) may read freely. What
 * waits at /pending is any call that would put brain content in front of a
 * client or the public:
 *  - a lowering to client or public (`access_set`, a share link,
 *    `email_page` with a link);
 *  - a write INTO an item a client or the public already reads: a page,
 *    note, table, drawing, file, folder, formula or app, its blocks, rows,
 *    draft, commit, title or place. Since workspaces W5b2 that is its
 *    grants: a workspace with a client user holds it (its own grant or its
 *    folder's), or a live open link shows it (its item or its served list).
 *    An embed changes no one's access any more, so the target alone decides;
 *  - a destination folder a client workspace reads (what lands there takes
 *    its rows);
 *  - a write into an agent or tool group at client or public level (a new
 *    tool in the client agent's group, say);
 *  - anything whose target cannot be read from its input (a command, a run,
 *    a recipe with a write step, a connector's tool).
 *
 * Every built-in write declares its rule on its policy (`clientSourced`,
 * the shapes in client-sourced-rule.ts; A5 step 6d moved them there from
 * WRITE_RULES). The sweep (client-sourced-rules.test.ts) fails when one is
 * missing, so a new write tool cannot slip past silently; at run time an
 * unclassified write (a builtin registered elsewhere) waits too. The owner
 * approving the pending entry runs the original call.
 */
import { and, arrayOverlaps, eq, inArray, or, sql } from 'drizzle-orm';
import { agents, appTableExports, db, nodes, toolGroups, mayReadInSql } from '@mantle/db';
import { clientSourcedSystem, clientWsSql } from './client-sourced';
import type { ClientSourcedRule, ClientSourcedWriteRule } from './client-sourced-rule';
import { builtinPolicy, policyLowers, policyMayLower, type ToolPolicy } from './tool-policy';

type Input = Record<string, unknown>;

/** The rule the guard applies to a builtin: its policy's `clientSourced`,
 *  or the lowering its policy declares (A5 step 6d: the rules moved onto
 *  the policies; WRITE_RULES is gone). */
export type WriteRule = { kind: 'lowering' } | ClientSourcedRule;

const LOWERING: WriteRule = Object.freeze({ kind: 'lowering' });

/**
 * The rule a builtin's policy says, with what the policy says already
 * derived: a tool whose `lowering` may lower is the lowering rule, and a
 * create's `createsIn` path is a destination the write rule checks, before
 * any path the rule names itself. Undefined: the policy declares none (a
 * read, or a write the guard does not know).
 */
export function writeRuleOf(policy: ToolPolicy | null | undefined): WriteRule | undefined {
  if (!policy) return undefined;
  if (policyMayLower(policy)) return LOWERING;
  const rule = policy.clientSourced;
  if (rule?.kind !== 'write' || !policy.createsIn) return rule;
  return { ...rule, paths: [policy.createsIn, ...(rule.paths ?? [])] };
}

/** A tool as the gate sees it: its slug and its handler descriptor. */
export type GateTool = { slug: string; handler: unknown };

export type GateVerdict = { gate: false } | { gate: true; why: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a client or the public reads the row's item: a client workspace
 *  holds it (its own grant or its folder's), or a live open link shows it
 *  (the link's own item, or on its served list). */
function exposedSql(ownerId: string) {
  // Written out in full: inside the subquery an unqualified id would name
  // the share's own id.
  return sql<boolean>`(
    ${mayReadInSql(undefined, clientWsSql(ownerId))}
    or exists (
      select 1 from shares s
       where s.owner_id = ${ownerId} and s.revoked_at is null and s.contact_id is null
         and (s.expires_at is null or s.expires_at > now())
         and coalesce(s.settings->>'mode', 'public') <> 'team'
         and (s.node_id = "nodes"."id"
              or coalesce(s.settings->'served', '[]'::jsonb) ? lower("nodes"."id"::text))))`;
}
const RUN: GateVerdict = { gate: false };
const wait = (why: string): GateVerdict => ({ gate: true, why });

/** The builtin a tool row runs (its handler ref), or null for another kind. */
function builtinRef(tool: GateTool): string | null {
  const h = tool.handler as { kind?: string; ref?: string } | null;
  if (h?.kind !== 'builtin') return null;
  return h.ref ?? tool.slug;
}

/** The rule for a builtin by its policy (`policyOf`, the registry's
 *  builtinPolicy by default), or undefined when it declares none. */
export function writeRuleFor(
  ref: string,
  policyOf: (slug: string) => ToolPolicy | null = builtinPolicy,
): WriteRule | undefined {
  return writeRuleOf(policyOf(ref));
}

/** Whether this tool makes new nodes (so a marked turn marks them).
 *  `policyOf` as clientSourcedGate takes it. */
export function toolCreatesNodes(
  tool: GateTool,
  policyOf: (slug: string) => ToolPolicy | null = builtinPolicy,
): boolean {
  const ref = builtinRef(tool);
  const rule = ref ? writeRuleFor(ref, policyOf) : undefined;
  return rule?.kind === 'write' && rule.creates === true;
}

/** The values of `fields` in `input`, flattened (absent or empty skipped). */
function valuesOf(input: Input, fields: readonly string[] | undefined): unknown[] {
  const out: unknown[] = [];
  for (const f of fields ?? []) {
    const v = input[f];
    if (v === undefined || v === null || v === '') continue;
    out.push(...(Array.isArray(v) ? (v as unknown[]) : [v]));
  }
  return out;
}

/** The trimmed strings among `vals`; null when any value is not a string. */
function stringsOf(vals: unknown[]): string[] | null {
  const out: string[] = [];
  for (const v of vals) {
    if (typeof v !== 'string') return null;
    out.push(v.trim());
  }
  return out;
}

/**
 * What a MARKED turn may do with this call: run it, or send it to pending
 * with the reason. Called only once the turn is marked. `policyOf` is the
 * registry's own policy lookup (builtinPolicy), passed in so this module
 * stays free of the registry: a builtin's effect and its `lowering` are read
 * from it. A failed check sends the call to pending.
 */
export async function clientSourcedGate(p: {
  ownerId: string;
  tool: GateTool;
  input: Input;
  policyOf: (slug: string) => ToolPolicy | null;
}): Promise<GateVerdict> {
  try {
    return await decide(p);
  } catch {
    return wait('the target check failed');
  }
}

async function decide(p: {
  ownerId: string;
  tool: GateTool;
  input: Input;
  policyOf: (slug: string) => ToolPolicy | null;
}): Promise<GateVerdict> {
  const readOnly = (slug: string) => p.policyOf(slug)?.effect === 'read';
  const ref = builtinRef(p.tool);
  if (ref === null) {
    // A recipe of reads only reads; an HTTP GET reads. Anything else a user
    // or a connector defined may write where its input does not say.
    const h = p.tool.handler as {
      kind?: string;
      method?: string;
      steps?: { tool?: unknown }[];
    } | null;
    if (h?.kind === 'recipe') {
      const reads = (h.steps ?? []).every((s) => typeof s.tool === 'string' && readOnly(s.tool));
      return reads ? RUN : wait('a recipe with a step that writes');
    }
    if (h?.kind === 'http' && (h.method ?? 'GET').toUpperCase() === 'GET') return RUN;
    return wait('a tool that can write where its input does not say');
  }
  const rule = writeRuleOf(p.policyOf(ref));
  if (!rule) return readOnly(ref) ? RUN : wait('a write tool the guard does not know');
  switch (rule.kind) {
    case 'free':
      return RUN;
    case 'lowering': {
      const policy = p.policyOf(ref);
      return policy && policyLowers(policy, p.input)
        ? wait('it would make brain content visible to clients or the public')
        : RUN;
    }
    case 'always':
      return !rule.when || rule.when(p.input) ? wait(rule.why) : RUN;
    case 'write':
      return writeVerdict(p.ownerId, rule, p.input);
  }
}

/** The verdict of a write rule for one call (exported for the oracle test
 *  of A5 step 6d, which runs main's WRITE_RULES through it). */
export async function writeVerdict(
  ownerId: string,
  rule: ClientSourcedWriteRule,
  input: Input,
): Promise<GateVerdict> {
  if (rule.alwaysWhen?.(input)) return wait('its target is named by path, not by id');
  const nodeIds = stringsOf([...valuesOf(input, rule.nodes), ...(rule.extraNodes?.(input) ?? [])]);
  const appIds = stringsOf(valuesOf(input, rule.apps));
  // An item named by anything but an id cannot be checked: it waits.
  if (!nodeIds || !appIds || [...nodeIds, ...appIds].some((id) => !UUID_RE.test(id))) {
    return wait('its target is not named by id');
  }
  const paths = stringsOf(valuesOf(input, rule.paths));
  if (!paths) return wait('its destination is not named by path');
  const agentSlugs = stringsOf(valuesOf(input, rule.agents)) ?? [];
  const groupSlugs = stringsOf(valuesOf(input, rule.groups)) ?? [];
  const toolSlugs = stringsOf(valuesOf(input, rule.tools)) ?? [];
  const named =
    nodeIds.length +
    appIds.length +
    paths.length +
    agentSlugs.length +
    groupSlugs.length +
    toolSlugs.length;
  if (named === 0) return RUN;
  return clientSourcedSystem(async (): Promise<GateVerdict> => {
    // An app: the app itself and every brain table it exports.
    const exported =
      appIds.length > 0
        ? await db
            .select({ id: appTableExports.tableNodeId })
            .from(appTableExports)
            .where(
              and(eq(appTableExports.ownerId, ownerId), inArray(appTableExports.appNodeId, appIds)),
            )
        : [];
    const wanted = [
      ...new Set([...nodeIds, ...appIds, ...exported.map((e) => e.id)].map((i) => i.toLowerCase())),
    ];
    if (wanted.length > 0) {
      const rows = await db
        .select({ id: nodes.id, exposed: exposedSql(ownerId) })
        .from(nodes)
        .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, wanted)));
      if (rows.length < wanted.length) return wait('its target is not an item of this brain');
      // Read by a client (a workspace with a client user holds it, by its
      // own grant or its folder's) or by the public (an open link shows it).
      if (rows.some((r) => r.exposed === true)) {
        return wait('it writes into an item clients or the public read');
      }
    }
    for (const path of paths) {
      // A folder at or above the destination that a client workspace reads:
      // what lands there takes the folder's rows (S6).
      const [shared] = await db
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.ownerId, ownerId),
            eq(nodes.type, 'branch'),
            sql`${nodes.path} @> ${path}::ltree`,
            mayReadInSql(undefined, clientWsSql(ownerId)),
          ),
        )
        .limit(1);
      if (shared) return wait('it puts something in a folder shared with clients');
    }
    // An agent a client talks to: the assistant of a workspace with a
    // client user (agent and tool-group levels are gone, workspaces W7b).
    if (agentSlugs.length > 0) {
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.ownerId, ownerId),
            inArray(agents.slug, agentSlugs),
            sql`${agents.workspaceId} = any(${clientWsSql(ownerId)})`,
          ),
        )
        .limit(1);
      if (rows.length > 0) {
        return wait('it changes an agent clients talk to');
      }
    }
    // A tool group such an assistant holds.
    if (groupSlugs.length > 0 || toolSlugs.length > 0) {
      const byGroup = groupSlugs.length > 0 ? inArray(toolGroups.slug, groupSlugs) : undefined;
      const byTool =
        toolSlugs.length > 0 ? arrayOverlaps(toolGroups.toolSlugs, toolSlugs) : undefined;
      const rows = await db
        .select({ slug: toolGroups.slug })
        .from(toolGroups)
        .innerJoin(
          agents,
          and(
            eq(agents.ownerId, toolGroups.ownerId),
            sql`${toolGroups.slug} = any(${agents.toolGroupSlugs})`,
          ),
        )
        .where(
          and(
            eq(toolGroups.ownerId, ownerId),
            or(byGroup, byTool),
            sql`${agents.workspaceId} = any(${clientWsSql(ownerId)})`,
          ),
        )
        .limit(1);
      if (rows.length > 0) {
        return wait('it changes a tool group an agent clients talk to holds');
      }
    }
    return RUN;
  });
}
