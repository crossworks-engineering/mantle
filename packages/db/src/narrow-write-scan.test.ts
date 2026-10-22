/**
 * The static narrow write scan (the full re-audit's
 * finding): every drizzle write of the source on a table that is
 * not a content table is allowed by the narrow role's allowlist, sits at a
 * full-route spot, is in a file that never runs on a narrow exit, or is
 * pinned open (a list that only shrinks).
 */
import { describe, expect, it } from 'vitest';
import * as schema from './schema';
import {
  NARROW_DENIED_FUNCTIONS,
  NARROW_PUBLIC_DEFINERS,
  NARROW_SYSTEM_FUNCTIONS,
  RUNTIME_DENIED_FUNCTIONS,
} from './runtime-role';
import {
  migrationFunctions,
  narrowAllows,
  narrowRunnable,
  scanCalls,
  scanRepo,
  scanRepoCalls,
  scanSource,
  tablesOf,
  writeKey,
} from './test-support/narrow-write-scan';
import {
  NARROW_SCAN_FN_DECIDED,
  NARROW_SCAN_FN_OPEN,
  NARROW_SCAN_FN_SYSTEM_FILES,
  NARROW_SCAN_OPEN,
  NARROW_SCAN_SYSTEM_FILES,
} from './test-support/narrow-write-scan.pins';

const repo = new URL('../../..', import.meta.url).pathname;
// The spot helpers' lists (a .mjs with no types: read by URL).
const { FULL_ROUTE_SPOT_WRAPPERS, FULL_ROUTE_SPOT_CALLBACKS } = (await import(
  new URL('../../../eslint-rules/as-system-routes.mjs', import.meta.url).href
)) as Record<'FULL_ROUTE_SPOT_WRAPPERS' | 'FULL_ROUTE_SPOT_CALLBACKS', Record<string, unknown>>;
const tables = tablesOf(schema as Record<string, unknown>);
/** onFullSystemRoute and the one-spot helpers (as-system-routes.mjs
 *  FULL_ROUTE_SPOT_WRAPPERS). */
const CALLS = ['onFullSystemRoute', 'onNarrowSpots', 'profileWrite'];

describe('the static narrow write scan', () => {
  const found = scanRepo(repo, ['server', 'packages'], tables, CALLS);
  const keys = [...new Set(found.map(writeKey))].sort();
  const open = Object.keys(NARROW_SCAN_OPEN);

  it('every write the allowlist does not hold is at a spot, system only, or pinned open', () => {
    const unheld = keys.filter(
      (k) => !NARROW_SCAN_SYSTEM_FILES[k.split(' ')[0]!] && !open.includes(k),
    );
    expect(unheld).toEqual([]);
  });

  it('the open pins are exact by occurrence: a new write of a pinned key fails too', () => {
    const counts: Record<string, number> = {};
    for (const w of found) {
      const k = writeKey(w);
      if (!NARROW_SCAN_SYSTEM_FILES[w.file]) counts[k] = (counts[k] ?? 0) + 1;
    }
    expect(counts).toEqual(
      Object.fromEntries(Object.entries(NARROW_SCAN_OPEN).map(([k, v]) => [k, v.n])),
    );
    for (const [k, v] of Object.entries(NARROW_SCAN_OPEN)) {
      expect(['reaches-narrow', 'covered-across-files'], k).toContain(v.tag);
      expect(v.why.length, k).toBeGreaterThanOrEqual(20);
    }
  });

  it('the pins are exact: every open entry and system file is still found (the list only shrinks)', () => {
    expect(open.filter((k) => !keys.includes(k))).toEqual([]);
    const files = new Set(keys.map((k) => k.split(' ')[0]!));
    expect(Object.keys(NARROW_SCAN_SYSTEM_FILES).filter((f) => !files.has(f))).toEqual([]);
    for (const why of Object.values(NARROW_SCAN_SYSTEM_FILES))
      expect(why.length).toBeGreaterThan(15);
    // The count when the scan began: down only.
    expect(open.length).toBeLessThanOrEqual(103);
  });

  it('reads a chain: a spot, a function passed to one, an upsert, a spread, comments and strings', () => {
    const src = `
      // db.update(heartbeats).set({ createdBy: x }) in a comment
      const s = 'db.delete(skills)';
      await db.update(heartbeats).set({ createdBy: x, updatedAt: now }).where(w);
      await onFullSystemRoute('heartbeat-maker', () => db.update(heartbeats).set({ schedule: s }));
      const write = () => db.update(skills).set({ instructions: t });
      await onFullSystemRoute('skill-text', write);
      await db.insert(pushPrefs).values(v).onConflictDoUpdate({ target: pushPrefs.id, set: { approvals: true } });
      await db.update(agents).set({ ...patch, updatedAt: now });
      await db.update(nodes).set({ title: 'x' });
    `;
    const w = scanSource('x.ts', src, tables, CALLS);
    expect(w.map((x) => [x.table, x.op, x.columns.join(','), x.atSpot])).toEqual([
      ['public.heartbeats', 'update', 'created_by,updated_at', false],
      ['public.heartbeats', 'update', 'schedule', true],
      ['public.skills', 'update', 'instructions', true],
      ['public.push_prefs', 'insert', 'approvals', false],
      ['public.agents', 'update', '*,updated_at', false],
    ]);
    expect(w.map(narrowAllows)).toEqual([false, false, false, true, false]);
  });

  it('onNarrowSpots covers its own table per call, never another; no file-wide cover', () => {
    const src = `
      const write = () => db.update(skills).set({ instructions: t });
      await onNarrowSpots(skills, 'update', next, write);
      const other = () => db.update(heartbeats).set({ createdBy: x });
      await onNarrowSpots(skills, 'update', next, other);
      const loose = () => db.update(tools).set({ handler: h });
      await loose();
      if (narrowNeedsSpot(tools, 'update', s)) await onFullSystemRoute('tool-config', loose);
    `;
    const w = scanSource('x.ts', src, tables, CALLS);
    expect(w.map((x) => [x.table, x.atSpot])).toEqual([
      ['public.skills', true],
      ['public.heartbeats', false],
      ['public.tools', false],
    ]);
  });

  it('the value rules are visible: a switch turned on, a new row on by default, a resume', () => {
    const src = `
      await db.update(skills).set({ enabled: true, updatedAt: now });
      await db.update(skills).set({ enabled: false, updatedAt: now });
      await db.update(skills).set({ enabled: on, updatedAt: now });
      await db.insert(calendarAccounts).values({ ownerId: o, url: u });
      await db.insert(calendarAccounts).values({ ownerId: o, url: u, enabled: false });
      await db.update(heartbeats).set({ status: 'active' });
    `;
    const w = scanSource('x.ts', src, tables, CALLS);
    expect(w.map((x) => x.valueRule)).toEqual([
      'a switch turned on (0323)',
      null,
      null,
      'a switch starts on (0324)',
      null,
      'a value rule of its table (0320)',
    ]);
    expect(narrowAllows(w[0]!)).toBe(false);
  });

  it('round 12 found the Studio commit, the connectors edit and the reflector off their spot; they are at it now', () => {
    for (const f of [
      'server/web/lib/studio/prompt-versions.ts',
      'server/web/lib/mcp-connectors.ts',
      'server/web/lib/openapi-connectors.ts',
      'server/api/src/agent/reflector.ts',
      'server/web/lib/agent-telegram.ts',
      'packages/email/src/accounts.ts',
      'packages/microsoft/src/outlook/manage.ts',
    ])
      expect(
        keys.filter((k) => k.startsWith(`${f} `)),
        f,
      ).toEqual([]);
  });
});

describe('the static narrow call scan (round 14: an EXECUTE refusal is no write)', () => {
  const fns = migrationFunctions(repo);
  const runnable = narrowRunnable(
    fns,
    [...Object.keys(NARROW_SYSTEM_FUNCTIONS), ...Object.keys(NARROW_PUBLIC_DEFINERS)],
    [...Object.keys(NARROW_DENIED_FUNCTIONS), ...Object.keys(RUNTIME_DENIED_FUNCTIONS)],
  );
  const spotCalls = [
    'onFullSystemRoute',
    ...Object.keys(FULL_ROUTE_SPOT_WRAPPERS),
    ...Object.keys(FULL_ROUTE_SPOT_CALLBACKS),
  ];
  const found = scanRepoCalls(
    repo,
    ['server', 'packages'],
    runnable,
    { ...NARROW_SCAN_SYSTEM_FILES, ...NARROW_SCAN_FN_SYSTEM_FILES },
    spotCalls,
  );

  it('every call the narrow role may not run is at a spot, in a system file, or of a decided function', () => {
    const undecided = [...found.keys()].filter((k) => !NARROW_SCAN_FN_DECIDED[k.split(' ')[1]!]);
    expect(undecided).toEqual([]);
  });

  it('the pins are exact per call: each file and function with its count (a new call fails)', () => {
    expect(Object.fromEntries([...found].sort())).toEqual(
      Object.fromEntries(Object.entries(NARROW_SCAN_FN_OPEN).sort()),
    );
    const used = new Set([...found.keys()].map((k) => k.split(' ')[1]!));
    expect(Object.keys(NARROW_SCAN_FN_DECIDED).filter((f) => !used.has(f))).toEqual([]);
    for (const why of Object.values(NARROW_SCAN_FN_DECIDED)) expect(why.length).toBeGreaterThan(30);
    // Never a function the narrow role may run (it would not be found).
    for (const f of Object.keys(NARROW_SCAN_FN_DECIDED)) expect(runnable.has(f), f).toBe(false);
  });

  it("reads the migrations' definers: the connector read is the narrow role's, a viewer definer is not", () => {
    expect(fns.get('mantle_connector_beyond_admin')?.definer).toBe(true);
    expect(runnable.has('mantle_connector_beyond_admin')).toBe(true);
    expect(runnable.has('mantle_app_holders')).toBe(false);
    expect(runnable.has('mantle_tg_chat_set')).toBe(false);
  });

  it('reads SQL text only: a call in a template at a spot, outside one, in a comment or a quoted list', () => {
    const src = `
      // db.execute(sql\`select mantle_app_holders(x)\`) in a comment
      const listed = 'public.mantle_app_holders(uuid,uuid)';
      await db.execute(sql\`select "public"."mantle_app_holders"(\${a}::uuid, \${b}::uuid)\`);
      await onFullSystemRoute('tool-config', () => db.execute(sql\`select mantle_tg_replay(\${a})\`));
      await db.execute(sql\`select x.mantle_not_a_call(1), mantle_brain_id()\`);
    `;
    expect(scanCalls('x.ts', src, spotCalls).map((c) => [c.fn, c.atSpot])).toEqual([
      ['mantle_app_holders', false],
      ['mantle_tg_replay', true],
      ['mantle_brain_id', false],
    ]);
  });
});
