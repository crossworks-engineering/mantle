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
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';
import type { ClientSourcedRule, ClientSourcedWriteRule } from './client-sourced-rule';
import { builtinPolicy, policyLowers, policyMayLower, type ToolPolicy } from './tool-policy';
import { UUID_RE } from '@mantle/std';

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

/** A Postgres array literal of `values`, each quoted (a slug or a path may
 *  hold a comma or a space). */
const textArray = (values: readonly string[]) =>
  `{${values.map((v) => `"${v.replace(/["\\]/g, (c) => `\\${c}`)}"`).join(',')}}`;
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
  // The rule in SQL, by its definer (mantle_client_sourced_gate, 0293): the
  // targets, an app's exported Tables, the destination folders, the
  // assistants and tool groups, over every row of the brain whatever the
  // turn reads (A6b: on the system pool before, 'client-sourced-check').
  const [row] = (await db.execute(
    sql`select "public"."mantle_client_sourced_gate"(${ownerId}::uuid,
          ${textArray(nodeIds)}::uuid[], ${textArray(appIds)}::uuid[], ${textArray(paths)}::text[],
          ${textArray(agentSlugs)}::text[], ${textArray(groupSlugs)}::text[],
          ${textArray(toolSlugs)}::text[]) as why`,
  )) as unknown as { why: string | null }[];
  return row?.why ? wait(row.why) : RUN;
}
