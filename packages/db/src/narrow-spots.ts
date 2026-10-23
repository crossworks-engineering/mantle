/**
 * Which full-route spots a write needs, named per table in one place (one narrowSpotFor instead of a branch per
 * caller). Each table a narrow exit edits through the
 * app's own screens and tools lists its rules here: the props that make a
 * set a grant or a text that runs, each with its spot, and the spot for
 * any other column the narrow login may not write (narrow-writes.ts
 * narrowNeedsSpot: the measured allowlist, the off-only switches and the
 * value rules).
 *
 * A set that needs more than one spot enters every one of them (nested):
 * an edit of a worker's vault key and its prompt runs at model-route and
 * skill-text, so each spot's count sees it. The write itself runs once,
 * on the full route, as before.
 *
 * eslint-rules/as-system-routes.mjs reads NARROW_TABLE_SPOTS: a call of
 * onNarrowSpots names its spots by its table (the first argument, a schema
 * export), and each must be listed for the calling file in
 * FULL_ROUTE_SPOT_FILES, as a literal spot is.
 */
import { getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { narrowNeedsSpot } from './narrow-writes';
import { loginHeldFromNarrow } from './gateway/scope-answers';
import { onFullSystemRoute, systemRouteNow, type FullRouteSpot } from './viewer';

type Values = Record<string, unknown>;

/** A rule: the props of `set` that need `spot` (none: the rule does not
 *  apply). */
type SpotRule = {
  readonly spot: FullRouteSpot;
  readonly claims: (set: Values) => readonly string[];
};

/** A rule that claims every prop of `props` the set names. */
function named(spot: FullRouteSpot, props: readonly string[]): SpotRule {
  return { spot, claims: (set) => props.filter((p) => set[p] !== undefined) };
}

/** memory_config's delegate_to (a delegate runs with its own tool groups:
 *  0318 keeps the key off the narrow login). The caller passes the patch's
 *  object, not the SQL merge it writes. */
function namesDelegate(value: unknown): boolean {
  return value != null && typeof value === 'object' && 'delegate_to' in value;
}

/**
 * Per table (schema.table): the spots onNarrowSpots may name for it, in
 * the order it enters them (`spots`, the list the lint reads), the rules
 * that claim props, and `rest`, the spot for any other column the narrow
 * login may not write (and for an insert or delete it may not make).
 */
export const NARROW_TABLE_SPOTS = Object.freeze({
  'public.agents': {
    spots: ['assistant-grant', 'skill-text', 'model-route'],
    rules: [
      // A grant: the role, the tool groups, a turn-on (0320: the narrow
      // login only switches it off), a delegate.
      {
        spot: 'assistant-grant',
        claims: (set: Values) => [
          ...(set.role !== undefined ? ['role'] : []),
          ...(set.toolGroupSlugs !== undefined ? ['toolGroupSlugs'] : []),
          ...(set.enabled === true ? ['enabled'] : []),
          ...(namesDelegate(set.memoryConfig) ? ['memoryConfig'] : []),
        ],
      },
      // What it runs and how far (its prompt, notes, skills, limits in
      // memory_config and params, its description): as a skill's
      // instructions.
      named('skill-text', [
        'systemPrompt',
        'personaNotes',
        'skillSlugs',
        'memoryConfig',
        'params',
        'description',
      ]),
    ],
    // Which vault key it sends and where (api_key_id, base_url,
    // configured_by and their backups), its provider and model.
    rest: 'model-route',
  },
  'public.ai_workers': {
    spots: ['skill-text', 'model-route'],
    // Its prompt and its params (a kind's extraction prompt and limits).
    rules: [named('skill-text', ['systemPrompt', 'params'])],
    // Its vault key, base URL, configuring login, provider, model.
    rest: 'model-route',
  },
  'public.tool_groups': {
    spots: ['tool-group-grant', 'tool-config'],
    // Its tool list (every assistant granted the group may call them) and
    // a turn-on: a grant.
    rules: [
      {
        spot: 'tool-group-grant',
        claims: (set: Values) => [
          ...(set.toolSlugs !== undefined ? ['toolSlugs'] : []),
          ...(set.enabled === true ? ['enabled'] : []),
        ],
      },
    ],
    // Its integration (where its calls and token go), configuring login.
    rest: 'tool-config',
  },
  // A tool's handler, its confirm flag, its external access.
  'public.tools': { spots: ['tool-config'], rules: [], rest: 'tool-config' },
  // Its schedule, assistant, skill or maker (whom and when it fires as).
  'public.heartbeats': { spots: ['heartbeat-maker'], rules: [], rest: 'heartbeat-maker' },
  // Its instructions (what every heartbeat and assistant that runs it does).
  'public.skills': { spots: ['skill-text'], rules: [], rest: 'skill-text' },
  // A feed started or switched on (it syncs, its items are ingested).
  'public.calendar_accounts': { spots: ['feed-enable'], rules: [], rest: 'feed-enable' },
  'public.ms_drives': { spots: ['feed-enable'], rules: [], rest: 'feed-enable' },
  // A collection switched on (its files are read and indexed again).
  'public.doc_collections': { spots: ['docs-root'], rules: [], rest: 'docs-root' },
  // Who answers together (its members), its name, a turn-on.
  'public.agent_groups': { spots: ['agent-group-grant'], rules: [], rest: 'agent-group-grant' },
  // A pool entry's model, routes, price or place.
  'public.curated_models': { spots: ['model-route'], rules: [], rest: 'model-route' },
} satisfies Record<
  string,
  { spots: readonly FullRouteSpot[]; rules: readonly SpotRule[]; rest: FullRouteSpot }
>);

type TableSpots = {
  spots: readonly FullRouteSpot[];
  rules: readonly SpotRule[];
  rest: FullRouteSpot;
};

function tableName(table: PgTable): string {
  return `${getTableConfig(table).schema ?? 'public'}.${getTableName(table)}`;
}

/**
 * The spots a write of `table` needs, in NARROW_TABLE_SPOTS order: none
 * when the narrow login may make it. `set` is an update's set or an
 * insert's values (by drizzle property name). A table not listed throws:
 * its rules belong here first.
 */
export function narrowSpotFor(
  table: PgTable,
  op: 'insert' | 'update' | 'delete',
  set: Values = {},
): readonly FullRouteSpot[] {
  const name = tableName(table);
  const entry = (NARROW_TABLE_SPOTS as Readonly<Record<string, TableSpots>>)[name];
  if (!entry) throw new Error(`narrowSpotFor: ${name} has no entry in NARROW_TABLE_SPOTS`);
  const need = new Set<FullRouteSpot>();
  const claimed = new Set<string>();
  if (op === 'update') {
    for (const rule of entry.rules) {
      const props = rule.claims(set);
      if (props.length === 0) continue;
      need.add(rule.spot);
      for (const p of props) claimed.add(p);
    }
  }
  const rest =
    op === 'update'
      ? Object.fromEntries(Object.entries(set).filter(([k]) => !claimed.has(k)))
      : set;
  if (narrowNeedsSpot(table, op, rest)) need.add(entry.rest);
  return entry.spots.filter((s) => need.has(s));
}

/**
 * Run `write` at every spot narrowSpotFor names for it (nested, in order),
 * or as it is when none. `decide` is what the spots are read from: the
 * write's own set, or a view of it (agents: the patch's memory_config
 * object where the write sends a SQL merge).
 */
export function onNarrowSpots<T>(
  table: PgTable,
  op: 'insert' | 'update' | 'delete',
  decide: Values,
  write: () => PromiseLike<T>,
): Promise<T> {
  const spots = narrowSpotFor(table, op, decide);
  const run = spots.reduceRight<() => Promise<T>>(
    (inner, spot) => () => onFullSystemRoute(spot, inner),
    async () => await write(),
  );
  return run();
}

/**
 * Run `write` (a login's disable or session end: auth.users disabled_at or
 * session_epoch) at the spot login-credential when the exit's route is the
 * narrow one and the login is held from the narrow login (the owner or an
 * Admin user: 0326's hold, loginHeldFromNarrow), else as it is. Read on the
 * route the exit picked, not the switch, so with the switch off the same
 * write is at the spot and the would-refuse count does not see it.
 */
export async function onLoginHoldSpot<T>(loginId: string, write: () => PromiseLike<T>): Promise<T> {
  if (systemRouteNow() !== 'narrow' || !(await loginHeldFromNarrow(loginId))) return await write();
  return onFullSystemRoute('login-credential', write);
}
