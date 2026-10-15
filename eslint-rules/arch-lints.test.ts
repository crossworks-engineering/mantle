import { join } from 'node:path';
import { RuleTester } from 'eslint';
// @ts-expect-error: plain-JS module, no types shipped.
import { asSystemExits, holderProblems, systemDbUses } from './as-system-exits.mjs';
import { describe, expect, it } from 'vitest';
import {
  asSystemSites,
  builtinSlugs,
  countedFiles,
  guardCalls,
  callerReads,
  isCounted,
  isRouteFile,
  keptNotes,
  listLiterals,
  readPathWrites,
  measure,
  rawAclLines,
  readRepoFile,
  routePolicyLists,
  stripComments,
  toolPolicyLists,
  toolPolicySwept,
  isDefinitionList,
  KIND_LIST_ALLOW,
  handKindLists,
  nodeTypes,
  ROLE_NAME_SOURCES,
  handRoleLists,
  roleNameSets,
  // @ts-expect-error: plain-JS module, no types shipped.
} from './arch-counts.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { noHandKindLists } from './no-hand-kind-lists.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { noHandRoleLists } from './no-hand-role-lists.mjs';
import {
  EXPORT_SYNC_ALLOW,
  appToolBrokerLogic,
  exportSyncCalls,
  noAppBrokerLogic,
  noHandExportSync,
  // @ts-expect-error: plain-JS module, no types shipped.
} from './app-broker.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { RAW_ACL_PINS, rule as rawAclRule } from './no-raw-acl-columns.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { AS_SYSTEM_PINS, rule as asSystemRule } from './as-system-allowlist.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { ROUTE_LIST_PINS, TOOL_LIST_PINS } from './no-policy-name-lists.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import {
  DOCS_STORE_FILES,
  STORE_PINS,
  fsWritesIn,
  rule as storeBrokersRule,
} from './store-brokers.mjs';
// @ts-expect-error: plain-JS module, no types shipped.
import { ACTOR_SETTER_PATTERN, rule as actorSettersRule } from './actor-setters.mjs';
import { AS_SYSTEM_OTHER_REASONS, AS_SYSTEM_TURN_REASONS } from '../packages/db/src/viewer';

/** Every reason asSystem takes (arch A2a). */
const KNOWN_AS_SYSTEM_REASONS: readonly string[] = [
  ...AS_SYSTEM_TURN_REASONS,
  ...AS_SYSTEM_OTHER_REASONS,
];

/**
 * The architecture ratchets (workspaces arch plan v2, section 11; A0), in
 * pinned-count mode: each lint lists what the repo holds today, file by
 * file, and fails on any other count. A count that went down needs its pin
 * lowered in the same change; one that went up needs review (say why in the
 * PR). The same counts feed scripts/arch-scoreboard.ts.
 */
const ROOT = join(__dirname, '..');
const got = measure(ROOT) as {
  numbers: Record<string, number>;
  perFile: {
    asSystem: Record<string, { count: number; reasons: string[] }>;
    asSystemExits: Record<string, number>;
    asSystemExitProblems: string[];
    rawAcl: Record<string, number>;
    toolLists: Record<string, { lists: number; entries: number }>;
    routeLists: Record<string, number>;
    stores: Record<string, string[]>;
    handKinds: Record<string, number>;
    handKindsAllowed: Record<string, number>;
    handRoles: Record<string, number>;
    handRolesAllowed: Record<string, number>;
    exportSync: Record<string, number>;
    exportSyncAllowed: Record<string, number>;
    brokerLogic: Record<string, number>;
    reindex: Record<string, { notify: number; embedding: number; summary: number }>;
    reindexAllowed: Record<string, { notify: number; embedding: number; summary: number }>;
  };
};

/** The differences between a pinned map and a found one, as lines. */
function diff<T>(pins: Record<string, T>, found: Record<string, T>, show = String): string[] {
  const out: string[] = [];
  for (const f of new Set([...Object.keys(pins), ...Object.keys(found)])) {
    const a = pins[f] === undefined ? 'none' : show(pins[f] as T);
    const b = found[f] === undefined ? 'none' : show(found[f] as T);
    if (a !== b) out.push(`${f}: pinned ${a}, found ${b}`);
  }
  return out.sort();
}

describe('the architecture ratchets (pinned counts)', () => {
  it('no-raw-acl-columns: raw ACL reads outside packages/db, file by file', () => {
    expect(diff(RAW_ACL_PINS, got.perFile.rawAcl)).toEqual([]);
    // A6: none left, and none may come back (plan v2 exit: 0).
    expect(RAW_ACL_PINS).toEqual({});
  });

  it('as-system-allowlist: asSystem call sites and their reasons, file by file', () => {
    const counts = Object.fromEntries(
      Object.entries(got.perFile.asSystem).map(([f, v]) => [f, v.count]),
    );
    const pinned = Object.fromEntries(
      Object.entries(AS_SYSTEM_PINS as Record<string, { count: number }>).map(([f, v]) => [
        f,
        v.count,
      ]),
    );
    expect(diff(pinned, counts)).toEqual([]);
    for (const [f, pin] of Object.entries(
      AS_SYSTEM_PINS as Record<string, { count: number; why: string[] }>,
    )) {
      const reasons = got.perFile.asSystem[f]?.reasons ?? [];
      // Each site names a real reason (arch A2a); 'test' never in product code.
      expect(pin.why, f).toEqual(reasons);
      expect(reasons.length, f).toBeGreaterThan(0);
      for (const r of reasons) {
        expect(KNOWN_AS_SYSTEM_REASONS, `${f}: ${r}`).toContain(r);
        expect(r, f).not.toBe('test');
      }
    }
  });

  it('actor-setters-in-db-only: no counted file outside packages/db names the actor settings', () => {
    const outside = countedFiles(ROOT).filter((f: string) => {
      if (f.startsWith('packages/db/src/')) return false;
      const text = readRepoFile(ROOT, f);
      return text !== null && ACTOR_SETTER_PATTERN.test(stripComments(text));
    });
    expect(outside).toEqual([]);
  });

  it('no-policy-name-lists: tool and route policy lists, file by file', () => {
    const show = (v: unknown) => JSON.stringify(v);
    expect(diff(TOOL_LIST_PINS, got.perFile.toolLists, show)).toEqual([]);
    expect(diff(ROUTE_LIST_PINS, got.perFile.routeLists)).toEqual([]);
  });

  it('store-brokers: the files that reach each disk store, store by store', () => {
    const show = (v: unknown) => JSON.stringify(v);
    expect(diff(STORE_PINS, got.perFile.stores, show)).toEqual([]);
  });

  it('store-brokers (A3b): the tables store is written by its broker alone', () => {
    expect(got.perFile.stores.tabledb).toEqual(['packages/content/src/table-broker.ts']);
  });

  it('store-brokers (A3b): the docs store has no disk writer', () => {
    const found: Record<string, string[]> = {};
    for (const f of DOCS_STORE_FILES as string[]) {
      const text = readRepoFile(ROOT, f) as string | null;
      expect(text, `${f} is gone: update DOCS_STORE_FILES`).not.toBeNull();
      const w = fsWritesIn(stripComments(text!)) as string[];
      if (w.length) found[f] = w;
    }
    expect(found).toEqual({});
  });

  it('no-guard-calls (a hard ban since A4 exit): no route file calls a guard', () => {
    // Every route reads the caller the gate answered (A4 hand batch B); the
    // ESLint rule (no-guard-calls.mjs) bans any guard outside session.ts.
    expect(got.numbers.guardCalls).toBe(0);
    expect(got.numbers.guardCallFiles).toBe(0);
  });

  it('no-direct-body-reads (A10 part 2): every route reads its body through the one reader', async () => {
    // readBody / readJson (server/web/lib/read-body.ts); the files that
    // read it another way are named with their reason, and each still does.
    const { BODY_READ_ALLOW } = await import('./route-plumbing.mjs');
    expect(got.perFile.bodyReadFiles).toEqual([]);
    expect(got.numbers.routeBodyReadFiles).toBe(0);
    expect([...got.perFile.bodyReadAllowed].sort()).toEqual(Object.keys(BODY_READ_ALLOW).sort());
  });

  it("no-error-text-replies (A10 part 2): no route puts a caught error's text in a reply outside the named list", async () => {
    // Throw; app.onError answers (the one table, or the opaque 500). The
    // named files still do (fold 2 continues): the list only shrinks.
    const { ERROR_TEXT_ALLOW } = await import('./route-plumbing.mjs');
    expect(got.perFile.errorTextFiles).toEqual([]);
    expect(got.numbers.routeErrorTextFiles).toBe(0);
    expect([...got.perFile.errorTextAllowed].sort()).toEqual(Object.keys(ERROR_TEXT_ALLOW).sort());
  });

  it('no-route-rate-limits (A10 #8): no file takes a rate limit outside the named list', async () => {
    // A limit is the row's (server/web/lib/route-limits.ts), taken by the
    // gate. Every file counts, not only route files (low round, L2): the
    // gate itself and the named budgets take one, and each still does.
    const { RATE_LIMIT_ALLOW } = await import('./route-plumbing.mjs');
    expect(got.perFile.rateLimitFiles).toEqual([]);
    expect(got.numbers.rateLimitCalls).toBe(0);
    expect([...got.perFile.rateLimitAllowed].sort()).toEqual(Object.keys(RATE_LIMIT_ALLOW).sort());
  });

  it('no-hand-export-sync (A10 #9): no export sync outside the app DB write path and the named files', () => {
    // A write schedules its exports' sync on the one write path
    // (packages/content/src/app-db-write.ts). The named files still
    // schedule it: the list only shrinks.
    expect(got.perFile.exportSync).toEqual({});
    expect(got.numbers.handExportSyncCalls).toBe(0);
    expect(Object.keys(got.perFile.exportSyncAllowed).sort()).toEqual(
      Object.keys(EXPORT_SYNC_ALLOW).sort(),
    );
  });

  it('no-app-broker-logic (A10 #9): app tool broker logic lives in the one broker only', () => {
    // The owner route, a member's run and the link route are configs of
    // runAppToolBroker (server/web/lib/app-tool-broker.ts).
    expect(got.perFile.brokerLogic).toEqual({});
    expect(got.numbers.appToolBrokerLogicFiles).toBe(0);
  });

  it('no-hand-kind-lists (A10 #12): no literal kind list outside the registry and the named files', () => {
    // A list of kinds is a filter over the kind registry
    // (packages/client-types/src/kind-lists.ts). The named files still hold
    // their list: the allow list only shrinks.
    expect(got.perFile.handKinds).toEqual({});
    expect(got.numbers.handKindLists).toBe(0);
    expect(Object.keys(got.perFile.handKindsAllowed).sort()).toEqual(
      Object.keys(KIND_LIST_ALLOW).sort(),
    );
  });

  it('no-hand-role-lists (A10 #13): no role, area or actor name list outside its source', () => {
    // Each list is written once, in its source file (ROLE_NAME_SOURCES);
    // every other copy imports it (docs/actors.md, "Role and area names").
    expect(got.perFile.handRoles).toEqual({});
    expect(got.numbers.handRoleLists).toBe(0);
    const files = (Object.values(ROLE_NAME_SOURCES) as { file: string }[]).map((s) => s.file);
    expect(Object.keys(got.perFile.handRolesAllowed).sort()).toEqual([...new Set(files)].sort());
  });

  it('no-hand-reindex (A10 #7): no hand re-index outside markContentChanged and the named files', async () => {
    // A write names what it changed to markContentChanged
    // (packages/db/src/content-changed.ts); the kind registry's `indexed`
    // says what each field feeds. The named files still hold their line: the
    // allow list only shrinks.
    const { REINDEX_ALLOW } = await import('./no-hand-reindex.mjs');
    expect(got.perFile.reindex).toEqual({});
    expect(got.numbers.reindexNotifyCalls).toBe(0);
    expect(got.numbers.reindexEmbeddingResets).toBe(0);
    expect(got.numbers.reindexSummaryClears).toBe(0);
    expect(Object.keys(got.perFile.reindexAllowed).sort()).toEqual(
      Object.keys(REINDEX_ALLOW).sort(),
    );
  });

  it('every live route that reads no caller is a public row (A4 exit)', async () => {
    // An /api/v1 alias reads where the handler it takes reads (the count
    // follows it); what is left judges its own credential and reads no
    // login: each is a public path the gate lets in.
    const { isPublicPath } = await import('../server/web/lib/auth-constants');
    const left = got.perFile.liveUnguardedFiles as string[];
    expect(left.length).toBe(got.numbers.liveRoutesWithoutGuard);
    const notPublic = left.filter((f) => {
      const path = f
        .replace(/^server\/web\/app/, '')
        .replace(/\/route\.tsx?$/, '')
        .replace(/\[[^\]]+\]/g, '00000000-0000-4000-8000-000000000000');
      return !isPublicPath(path);
    });
    expect(notPublic).toEqual([]);
  });

  it('every row that is not public and not a page reads a caller, row by row (A4 exit, fix round 1 M1)', async () => {
    // The file-level count above reads route files by path; this reads the
    // rows themselves, as the gate does: buildRouteRow refuses a row that
    // is not public and reads no caller at boot, so a new method that reads
    // nothing in a route file that reads elsewhere is refused too.
    const { routeManifest } = await import('../server/web/server/route-manifest.gen');
    const { buildRoutePolicy } = await import('../server/web/lib/auth/route-policy');
    const rows = [...buildRoutePolicy(routeManifest).values()];
    const unread = rows.filter((r) => !r.caller && !r.public && !r.page).map((r) => r.key);
    expect(unread).toEqual([]);
    // The pins: rows with a caller, of all the rows.
    expect(rows.filter((r) => r.caller).length).toBe(981);
    expect(rows.length).toBe(1044);
  });

  it("buildRouteRow's stand-in escape is named only where it is defined; tests pass it (fix round 1 M1)", () => {
    const named = countedFiles(ROOT).filter((f: string) =>
      /\bstandIn\b/.test(stripComments(readRepoFile(ROOT, f) ?? '')),
    );
    expect(named).toEqual([
      'server/web/lib/auth/route-policy.ts',
      'server/web/server/route-loader.ts',
    ]);
  });
});

describe('the counters', () => {
  it('blank comments and keep strings', () => {
    const t = 'a // x read_ws\n/* home_ws\n write_ws */ b \'http://x\' "//y"';
    const s = stripComments(t);
    expect(s.split('\n')).toHaveLength(3);
    expect(s).not.toMatch(/read_ws|home_ws|write_ws/);
    expect(s).toContain("'http://x'");
    expect(s).toContain('"//y"');
    expect(rawAclLines('// read_ws\nconst a = n.read_ws;\n/**\n * homeWs\n */')).toBe(1);
  });

  it('asSystem exits (A6 fix round 1, L1): every use of a function holding asSystem', () => {
    const door = [
      'function telegramLoginSystem<T>(fn: () => Promise<T>): Promise<T> {',
      "  return asSystem(fn, 'login-telegram');",
      '}',
      '// telegramLoginSystem(() => x) in a comment is no use',
      'const a = await telegramLoginSystem(() => read());',
      'const b = await telegramLoginSystem(async () => write());',
    ].join('\n');
    // A conditional wrapper: two sites, one exit per use.
    const wrapper = [
      'async function heartbeatRow<T>(fn: () => Promise<T>): Promise<T> {',
      "  return admin ? asSystem(fn, 'admin-area') : asSystem(fn, 'heartbeat-own-row');",
      '}',
      'await heartbeatRow(() => x());',
      'await heartbeatRow(() => y());',
      'await heartbeatRow(() => z());',
      'list.map(heartbeatRow);',
    ].join('\n');
    // Arrow and async forms, exported: their uses in other files count.
    const lib = [
      "export const inRuleInQuery = async <R,>(body: () => Promise<R>) => asSystem(body, 'rule-in-query');",
      "export const unused = async () => { await asSystem(() => q(), 'x'); };",
      'inRuleInQuery(() => local());',
    ].join('\n');
    const user = [
      "import { inRuleInQuery } from '@/lib/auth/rule-in-query';",
      'await inRuleInQuery(() => a());',
      'await inRuleInQuery(() => b());',
    ].join('\n');
    const ns = [
      "import * as rq from '@/lib/auth/rule-in-query';",
      'await rq.inRuleInQuery(() => a());',
    ].join('\n');
    // A file that does not import the name: its own `inRuleInQuery` is no use.
    const other = 'function inRuleInQuery() {}\ninRuleInQuery();';
    const tool =
      "export const tool = { handler: async () => asSystem(() => q(), 'login-telegram') };";
    const top = "await asSystem(() => q(), 'audit-log');";
    const r = asSystemExits([
      { path: 'a.ts', text: door },
      { path: 'w.ts', text: wrapper },
      { path: 'lib.ts', text: lib },
      { path: 'u.ts', text: user },
      { path: 'n.ts', text: ns },
      { path: 'o.ts', text: other },
      { path: 't.ts', text: tool },
      { path: 's.ts', text: top },
    ]);
    expect(r.byFile).toEqual({
      'a.ts': 2,
      'w.ts': 4,
      'lib.ts': 2,
      'u.ts': 2,
      'n.ts': 1,
      't.ts': 1,
      's.ts': 1,
    });
    expect(r.problems).toEqual([]);
    const held = Object.fromEntries(r.holders.map((h) => [`${h.path} ${h.name}`, h.reasons]));
    expect(held['w.ts heartbeatRow']).toEqual(['admin-area', 'heartbeat-own-row']);
    // A renamed import would hide its uses: refused.
    expect(
      asSystemExits([
        { path: 'lib.ts', text: lib },
        { path: 'r.ts', text: "import { inRuleInQuery as go } from 'x';\ngo(() => 1);" },
      ]).problems,
    ).toEqual(['r.ts renames the asSystem holder inRuleInQuery (as go): use its name']);
    expect(
      holderProblems([
        { name: 'f', exported: true, path: 'a.ts' },
        { name: 'f', exported: true, path: 'b.ts' },
      ]),
    ).toEqual(['exported asSystem holder f in a.ts, b.ts: rename one']);
  });

  it('asSystem exits: one honest count, pinned, no unreadable holder', () => {
    // Pinned in scripts/arch-scoreboard.pins.json (asSystemExits), so no
    // exit is added unseen, by a new site or a new use of an old one. The
    // plan v2 exit, at most 40, is not met yet: docs/actors.md, A6, lists
    // the holders and their uses.
    const n = got.numbers;
    expect(n.asSystemExits).toBeGreaterThanOrEqual(n.asSystemSites);
    expect(got.perFile.asSystemExitProblems).toEqual([]);
    expect(Object.values(got.perFile.asSystemExits).reduce((a, b) => a + b, 0)).toBe(
      n.asSystemExits,
    );
  });

  it('direct systemDb uses: every use but the declaration, imports and exports', () => {
    const text = [
      "import { systemDb } from '@mantle/db';",
      'export const systemDb2 = 1;',
      'await systemDb.select().from(t);',
      'void systemDb.execute(q);',
      "const s = 'systemDb in a string';",
      '// systemDb in a comment',
      'export { systemDb };',
    ].join('\n');
    expect(systemDbUses('x.ts', text)).toBe(2);
    expect(got.numbers.systemDbUses).toBeGreaterThan(0);
  });

  it('count asSystem calls with their reasons, not the definition or imports', () => {
    const src = [
      "import { asSystem } from '@mantle/db';",
      'export async function asSystem(fn, why) {}',
      "await asSystem(() => db.select(), 'kind-root');",
      "await asSystem(\n  async () => {\n    f('x');\n  },\n  'name-taken',\n);",
      '// asSystem(() => 1, "nope")',
    ].join('\n');
    expect(asSystemSites(src)).toEqual({ count: 2, reasons: ['kind-root', 'name-taken'] });
  });

  it('find list literals, a nested list belonging to the outer one', () => {
    const src =
      "const A: ReadonlySet<string> = new Set(['a', 'b']);\nconst B = [['x', 1], ['y', 2]];\nf(['no']);";
    expect(listLiterals(src)).toEqual(["['a', 'b']", "[['x', 1], ['y', 2]]"]);
    const slugs = new Set(['note_create', 'page_create', 'task_create']);
    expect(
      toolPolicyLists(
        "const S = new Set(['note_create', 'page_create', 'task_create', 'x']);",
        slugs,
      ),
    ).toEqual([3]);
    // A list of definition objects is not a policy list (A5: RUN_TOOLS).
    const defs =
      "export const T: Def[] = [\n  { slug: 'note_create', handler: h },\n  { slug: 'page_create', inputSchema: {} },\n  { slug: 'task_create', handler: h },\n];";
    expect(isDefinitionList(listLiterals(defs)[0])).toBe(true);
    expect(toolPolicyLists(defs, slugs)).toEqual([]);
    // A list of slug-only objects is a policy list keyed by name: counted.
    const slugOnly =
      "export const T = [{ slug: 'note_create' }, { slug: 'page_create' }, { slug: 'task_create' }];";
    expect(isDefinitionList(listLiterals(slugOnly)[0])).toBe(false);
    expect(toolPolicyLists(slugOnly, slugs)).toEqual([3]);
    const mixed =
      "export const T = [{ slug: 'note_create', handler: h }, { slug: 'page_create' }, { slug: 'task_create' }];";
    expect(isDefinitionList(listLiterals(mixed)[0])).toBe(false);
    expect(isDefinitionList("['note_create', { slug: 'x' }]")).toBe(false);
    expect(routePolicyLists("const R = ['GET /api/a', 'POST /api/b', '/api/c'];")).toEqual([3]);
    expect(routePolicyLists("const R = ['GET /api/a', 'x'];")).toEqual([]);
  });

  it('leave out only the deferred core list, never the rest of the selection (fix round 1, LOW-9)', () => {
    expect(toolPolicySwept('packages/tools/src/selection/core.ts')).toBe(false);
    expect(toolPolicySwept('packages/tools/src/selection/deferred.ts')).toBe(true);
    expect(toolPolicySwept('server/web/lib/system-manifest/manifest.ts')).toBe(false);
    expect(toolPolicySwept('packages/tools/src/turn-listing.ts')).toBe(true);
  });

  it('count guard calls and know a route file', () => {
    expect(
      guardCalls('const u = await getChatLoginOr401();\n// getMemberOr401()\ngetLoginOr401();'),
    ).toBe(2);
    expect(callerReads('const u = ownerCaller();\n// ownerCaller()\ngetOwnerOr401();')).toBe(1);
    expect(isRouteFile('server/web/app/api/pages/route.ts')).toBe(true);
    expect(isRouteFile('server/web/lib/pages.ts')).toBe(false);
  });

  it('count product code only', () => {
    expect(isCounted('packages/content/src/x.ts')).toBe(true);
    expect(isCounted('packages/content/src/x.test.ts')).toBe(false);
    expect(isCounted('packages/db/migrations/0001_x.sql')).toBe(false);
    expect(isCounted('server/web/server/route-manifest.gen.ts')).toBe(false);
    expect(isCounted('scripts/arch-scoreboard.ts')).toBe(false);
    // A build, archive, public or dist folder is skipped, but not a route
    // segment of that name under server/web/app/ (A4 step 3b part 4).
    expect(isCounted('packages/x/build/y.ts')).toBe(false);
    expect(isCounted('server/web/public/sw.js')).toBe(false);
    expect(isCounted('server/archive/old.ts')).toBe(false);
    expect(isCounted('server/web/app/api/apps/[id]/build/route.ts')).toBe(true);
    expect(isCounted('server/web/app/api/workspaces/[id]/archive/route.ts')).toBe(true);
    expect(isCounted('server/web/app/node_modules/x/route.ts')).toBe(false);
    expect(countedFiles(ROOT).length).toBeGreaterThan(500);
    expect(readRepoFile(ROOT, 'no/such/file.ts')).toBeNull();
    expect(builtinSlugs(ROOT).has('note_create')).toBe(true);
    // The heartbeat tools are defined in packages/runtime (A5 step 6d): a
    // list of their names counts too.
    const slugs = builtinSlugs(ROOT);
    expect(slugs.has('heartbeat_complete')).toBe(true);
    expect(
      toolPolicyLists(
        "const X = ['heartbeat_complete', 'heartbeat_snooze', 'heartbeat_list'];",
        slugs,
      ),
    ).toEqual([3]);
  });
});

describe('the hand re-index counter (A10 #7)', () => {
  it('counts notify calls, raw node_ingested notifies, vector resets and summary clears', async () => {
    const { handReindex } = await import('./no-hand-reindex.mjs');
    expect(handReindex('await notifyNodeIngested(id);')).toEqual({
      notify: 1,
      embedding: 0,
      summary: 0,
    });
    expect(handReindex("await sql`select pg_notify('node_ingested', ${id}::text)`;").notify).toBe(
      1,
    );
    expect(handReindex('.set({ embedding: null, data })').embedding).toBe(1);
    expect(handReindex('delete newData.summary;').summary).toBe(1);
    expect(handReindex("sql`update nodes set data = data - 'summary'`").summary).toBe(1);
  });

  it('does not count a definition, a comment, prose, a listener or a summary_model key', async () => {
    const { handReindex } = await import('./no-hand-reindex.mjs');
    const none = { notify: 0, embedding: 0, summary: 0 };
    expect(handReindex('export async function notifyNodeIngested(nodeId) {}')).toEqual(none);
    expect(handReindex('// await notifyNodeIngested(id); embedding: null')).toEqual(none);
    expect(handReindex('const d = "Re-fires the pg_notify(\'node_ingested\') signal";')).toEqual(
      none,
    );
    expect(handReindex("await sql.listen('node_ingested', cb);")).toEqual(none);
    expect(handReindex('delete data.summary_model;')).toEqual(none);
  });
});

describe('the hand kind list counter (A10 #12)', () => {
  const types = nodeTypes(ROOT) as Set<string>;
  const kinds = (text: string, path = 'x.ts') => handKindLists(text, types, path) as number[];
  it('counts a literal list of 3 or more kinds: assigned, a Set, a z.enum, inline', () => {
    expect(kinds("const A = ['page', 'note', 'draw'];")).toEqual([3]);
    expect(kinds("const S = new Set(['file', 'documentation', 'sermon']);")).toEqual([3]);
    expect(kinds("z.enum(['branch', 'email', 'file', 'note'])")).toEqual([4]);
    expect(kinds("if (!['page', 'note', 'task'].includes(t)) return;")).toEqual([3]);
    expect(kinds("f(x, ['page', 'note', 'table'])")).toEqual([3]);
  });

  it('counts the lists a text scan missed (low round, F2)', () => {
    // After `of`, `&&`, `||` and `export default`; in a spread; a template.
    expect(kinds("for (const t of ['page', 'note', 'draw']) f(t);")).toEqual([3]);
    expect(kinds("const ok = x && ['page', 'note', 'draw'].includes(t);")).toEqual([3]);
    expect(kinds("const ok = x || ['page', 'note', 'draw'].includes(t);")).toEqual([3]);
    expect(kinds("export default ['page', 'note', 'draw'];")).toEqual([3]);
    expect(kinds("const A = [...B, 'page', 'note', 'draw'];")).toEqual([3]);
    expect(kinds('const A = [`page`, `note`, `draw`];')).toEqual([3]);
    // A string union, an object keyed by kinds (a type too), a chain, a
    // switch's shared cases and a SQL list in a template or a string.
    expect(kinds("type K = 'page' | 'note' | 'draw';")).toEqual([3]);
    expect(kinds("const L = { page: 'Page', note: 'Note', 'draw': 'Drawing' };")).toEqual([3]);
    expect(kinds('type L = { page: string; note: string; draw: string };')).toEqual([3]);
    expect(
      kinds("if (t === 'page' || t === 'note' || n?.type === 'x' || t === 'draw') {}"),
    ).toEqual([3]);
    expect(kinds("switch (t) { case 'page': case 'note': case 'draw': return 1; }")).toEqual([3]);
    expect(kinds("sql`select 1 from nodes where type in ('page', 'note', 'draw')`;")).toEqual([3]);
    expect(kinds("q(\"select 1 where type = any(array['page','note','draw'])\");")).toEqual([3]);
  });

  it('does not count two kinds, a comment, prose, a list mostly of other words, or behaviour per kind', () => {
    expect(kinds("const A = ['page', 'note'];")).toEqual([]);
    expect(kinds("// ['page', 'note', 'draw']\nconst a = 1;")).toEqual([]);
    expect(kinds("/* type K = 'page' | 'note' | 'draw'; */")).toEqual([]);
    expect(kinds("const d = \"e.g. ['page','note','draw']\";")).toEqual([]);
    expect(
      kinds(
        "const G = ['memory-core', 'files', 'notes', 'journal', 'email', 'location', 'replay', 'persona'];",
      ),
    ).toEqual([]);
    expect(kinds("const R = [['/draw', 'draw'], ['/notes', 'note'], ['/x', 'page']];")).toEqual([]);
    // A dispatch table (every member a function) and a switch whose cases
    // have bodies of their own: behaviour per kind, not a list.
    expect(
      kinds('forAcceptedKind(i, { page: (p) => 1, note: () => 2, draw() { return 3; } });'),
    ).toEqual([]);
    expect(
      kinds("switch (t) { case 'page': return 1; case 'note': return 2; case 'draw': return 3; }"),
    ).toEqual([]);
    // A chain on three subjects is no list; a SQL list with a parameter is not literal.
    expect(kinds("if (a === 'page' || b === 'note' || c === 'draw') {}")).toEqual([]);
    expect(kinds("sql`where type in ('page', 'note', ${t})`;")).toEqual([]);
  });

  it('reports each list where it is written', async () => {
    const { handKindListSites } = await import('./arch-counts.mjs');
    const sites = handKindListSites(
      "const a = 1;\nconst L = { page: 1, note: 2, draw: 3 };\ntype K =\n  | 'page'\n  | 'note'\n  | 'draw';",
      types,
      'x.ts',
    ) as { form: string; start: { line: number; column: number } }[];
    expect(sites.map((x) => [x.form, x.start.line, x.start.column])).toEqual([
      ['keys', 2, 10],
      ['union', 4, 2],
    ]);
  });

  it('fails loudly when the node types cannot be read (low round, L2)', () => {
    expect(() => nodeTypes('/nonexistent-repo')).toThrow(/no node_type enum/);
  });
});

describe('the app broker counters (A10 #9)', () => {
  it('count export sync calls, not the definition', () => {
    expect(
      exportSyncCalls('scheduleAppTableExportSync(o, a);\nscheduleAppTableExportSync (o, b);'),
    ).toBe(2);
    expect(exportSyncCalls('export function scheduleAppTableExportSync(o: string) {}')).toBe(0);
    expect(exportSyncCalls("import { scheduleAppTableExportSync } from 'x';")).toBe(0);
  });

  it('count broker steps in server/ outside the broker, and a broker route parsing or dispatching', () => {
    const route = 'server/web/app/api/apps/[id]/tool-broker/route.ts';
    expect(
      appToolBrokerLogic('const v = await appToolVerdict(l, o, d, s);', 'server/web/lib/x.ts'),
    ).toBe(1);
    expect(
      appToolBrokerLogic(
        'const v = await appToolVerdict(l, o, d, s);',
        'server/web/lib/app-tool-broker.ts',
      ),
    ).toBe(0);
    expect(
      appToolBrokerLogic('const v = await appToolVerdict(l, o, d, s);', 'packages/tools/src/x.ts'),
    ).toBe(0);
    expect(appToolBrokerLogic('const b = Body.safeParse(await readJson(req));', route)).toBe(2);
    expect(appToolBrokerLogic('return dispatchTool(t, i, c);', route)).toBe(1);
    expect(appToolBrokerLogic('return runAppToolBroker(req, { via: "owner" });', route)).toBe(0);
    expect(appToolBrokerLogic('return dispatchTool(t, i, c);', 'server/web/lib/x.ts')).toBe(0);
  });
});

describe('the hand role list counter (A10 #13)', () => {
  const sets = roleNameSets(ROOT) as Record<string, { values: Set<string>; min: number }>;
  const concepts = (text: string, path = 'packages/x/src/y.ts') =>
    (handRoleLists(text, sets, path) as { concept: string; allowed: boolean }[])
      .filter((r) => !r.allowed)
      .map((r) => r.concept);

  it('reads every source', () => {
    expect(Object.keys(sets).sort()).toEqual(Object.keys(ROLE_NAME_SOURCES).sort());
    expect([...sets.loginRole!.values]).toEqual(['admin', 'member']);
  });

  it('fails loudly when a source cannot be read (low round, L2)', () => {
    expect(() => roleNameSets('/nonexistent-repo')).toThrow(/no packages\/client-types/);
  });

  it('counts a list, a Set, a z.enum, a union and a comparison chain of one concept', () => {
    expect(concepts("const R = ['admin', 'member'];")).toEqual(['loginRole']);
    expect(concepts("const S = new Set(['member', 'admin']);")).toEqual(['loginRole']);
    expect(concepts("role: z.enum(['admin', 'member']).optional(),")).toEqual(['loginRole']);
    expect(concepts("type R = 'admin' | 'member' | null;")).toEqual(['loginRole']);
    expect(concepts("return v === 'admin' || v === 'member';")).toEqual(['loginRole']);
    expect(concepts("typeof r === 'string' && r !== 'admin' && r !== 'member'")).toEqual([
      'loginRole',
    ]);
    expect(concepts("if (\n  t.role !== 'admin' &&\n  t.role !== 'member'\n) {}")).toEqual([
      'loginRole',
    ]);
    expect(concepts("type A = 'settings' | 'users' | 'keys';")).toEqual(['workspaceArea']);
    expect(
      concepts("type S = { actor: 'owner' | 'agent' | 'mcp' | 'system' | 'member' };"),
    ).toEqual(['historyActor']);
    expect(concepts("type A = { kind: 'owner' | 'agent' };")).toEqual(['recallActor']);
    expect(concepts("const L = ['public', 'client', 'team', 'admin'] as const;")).toEqual([
      'accessLevel',
    ]);
  });

  it('counts what a text scan missed (low round, L1)', () => {
    // A superset of the login roles: a stale copy that still names more.
    expect(concepts("type V = 'admin' | 'member' | 'client' | 'contact' | 'public';")).toEqual([
      'loginRole',
    ]);
    expect(concepts("const R = ['owner', 'admin', 'member'];")).toEqual(['loginRole']);
    // A `?.` or call subject, a switch's shared cases, SQL in a template.
    expect(concepts("if (a?.role === 'admin' || a?.role === 'member') {}")).toEqual(['loginRole']);
    expect(concepts("if (roleOf(x) !== 'admin' && roleOf(x) !== 'member') {}")).toEqual([
      'loginRole',
    ]);
    expect(concepts("switch (r) { case 'admin': case 'member': return true; }")).toEqual([
      'loginRole',
    ]);
    expect(concepts("sql`select id from auth.users where role in ('admin', 'member')`")).toEqual([
      'loginRole',
    ]);
  });

  it('does not count one name, another concept, a subset below min, a comment or behaviour per role', () => {
    expect(concepts("if (role === 'admin') return;")).toEqual([]);
    expect(concepts("const k = r === 'admin' ? 1 : r === 'member' ? 2 : 3;")).toEqual([]);
    expect(concepts("type C = 'owner' | 'member' | 'agent' | 'client';")).toEqual([]);
    expect(concepts("type L = 'admin' | 'team';")).toEqual([]);
    expect(concepts("const F = ['files', 'tables', 'pages', 'notes'];")).toEqual([]);
    expect(concepts("// type R = 'admin' | 'member';\nconst a = 1;")).toEqual([]);
    // Built from the source with the extras named: no hand copy.
    expect(concepts("type V = LoginRole | 'client' | 'contact';")).toEqual([]);
    // A table keyed by role, and cases with bodies of their own.
    expect(concepts('const ROUTES = { admin: 1, member: 2 };')).toEqual([]);
    expect(concepts("switch (r) { case 'admin': return 1; case 'member': return 2; }")).toEqual([]);
  });

  it('allows a list in its own source file only', () => {
    const src = (ROLE_NAME_SOURCES as Record<string, { file: string }>).loginRole!.file;
    expect(concepts("export const LOGIN_ROLES = ['admin', 'member'] as const;", src)).toEqual([]);
    expect(
      concepts(
        "const A = ['settings', 'users', 'assistants'];",
        (ROLE_NAME_SOURCES as Record<string, { file: string }>).loginRole!.file,
      ),
    ).toEqual(['workspaceArea']);
  });
});

describe('the scoreboard pins', () => {
  it('a re-pin keeps a note while its pin holds and drops it once it came down', () => {
    const notes = { a: 'raised 1 to 2', b: 'raised 3 to 4', gone: 'no number' };
    expect(keptNotes(notes, { a: 2, b: 4 }, { a: 2, b: 3 })).toEqual({
      a: 'raised 1 to 2',
      gone: 'no number',
    });
    expect(keptNotes(undefined, {}, {})).toEqual({});
  });

  it('counts the named writes inside read paths', () => {
    const names = readPathWrites(ROOT) as string[];
    expect(names.length).toBe(got.numbers.readPathWrites);
    for (const n of names) expect(n).toMatch(/^(repair|backfill):[a-z0-9-]+$/);
  });
});

describe('the editor rules', () => {
  const tester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: 'module' } });
  it('flag a raw ACL read in an unpinned file, and none in packages/db or a comment', () => {
    tester.run('no-raw-acl-columns', rawAclRule, {
      valid: [
        { code: 'const a = n.read_ws;', filename: '/r/packages/db/src/x.ts' },
        { code: '// read_ws\nconst b = 1;', filename: '/r/packages/search/src/new.ts' },
        { code: 'const a = n.read_ws;', filename: '/r/packages/search/src/new.test.ts' },
      ],
      invalid: [
        {
          code: 'const a = n.read_ws;',
          filename: '/r/packages/search/src/new.ts',
          errors: [{ messageId: 'over' }],
        },
      ],
    });
  });

  it('flag asSystem in an unpinned file, and allow a pinned file up to its pin', () => {
    const [pinned, pin] = Object.entries(AS_SYSTEM_PINS as Record<string, { count: number }>)[0]!;
    const calls = (n: number) =>
      Array.from({ length: n }, () => "asSystem(() => 1, 'x');").join('\n');
    tester.run('as-system-allowlist', asSystemRule, {
      valid: [{ code: calls(pin.count), filename: `/r/${pinned}` }],
      invalid: [
        {
          code: calls(1),
          filename: '/r/packages/search/src/new.ts',
          errors: [{ messageId: 'over' }],
        },
        {
          code: calls(pin.count + 1),
          filename: `/r/${pinned}`,
          errors: [{ messageId: 'over' }],
        },
      ],
    });
  });

  it('no-hand-export-sync: a hand export sync fails outside the write path and the named files', () => {
    const [named] = Object.keys(EXPORT_SYNC_ALLOW as Record<string, string>);
    const call = 'scheduleAppTableExportSync(o, a);';
    tester.run('no-hand-export-sync', noHandExportSync, {
      valid: [
        { code: call, filename: '/r/packages/content/src/app-db-write.ts' },
        { code: call, filename: `/r/${named}` },
        { code: call, filename: '/r/packages/tools/src/new.test.ts' },
      ],
      invalid: [
        { code: call, filename: '/r/packages/tools/src/new.ts', errors: [{ messageId: 'call' }] },
      ],
    });
  });

  it('no-app-broker-logic: a verdict step outside the broker, or a broker route that parses, fails', () => {
    tester.run('no-app-broker-logic', noAppBrokerLogic, {
      valid: [
        { code: 'appToolVerdict(l, o, d, s);', filename: '/r/server/web/lib/app-tool-broker.ts' },
        {
          code: 'export const POST = (req, c) => runAppToolBroker(req, c);',
          filename: '/r/server/web/app/s/[token]/tool-broker/route.ts',
        },
        { code: 'appToolVerdict(l, o, d, s);', filename: '/r/packages/tools/src/new.ts' },
      ],
      invalid: [
        {
          code: 'appToolVerdict(l, o, d, s);',
          filename: '/r/server/web/lib/new.ts',
          errors: [{ messageId: 'logic' }],
        },
        {
          code: 'const b = await readJson(req);',
          filename: '/r/server/web/app/s/[token]/tool-broker/route.ts',
          errors: [{ messageId: 'logic' }],
        },
      ],
    });
  });

  it('no-hand-kind-lists: a literal kind list fails outside the named files, where it is written', () => {
    const [named] = Object.keys(KIND_LIST_ALLOW as Record<string, string>);
    const list = "export const K = ['page', 'note', 'draw'];";
    tester.run('no-hand-kind-lists', noHandKindLists, {
      valid: [
        { code: list, filename: `/r/${named}` },
        { code: list, filename: '/r/packages/content/src/new.test.ts' },
        { code: "export const K = ['page', 'note'];", filename: '/r/packages/content/src/new.ts' },
      ],
      invalid: [
        {
          code: list,
          filename: '/r/packages/content/src/new.ts',
          errors: [{ messageId: 'list', line: 1, column: 18, endLine: 1, endColumn: 42 }],
        },
        {
          code: "const a = 1;\nfor (const t of ['page', 'note', 'draw']) a;",
          filename: '/r/server/web/lib/new.ts',
          errors: [{ messageId: 'list', line: 2, column: 17 }],
        },
      ],
    });
  });

  it('no-hand-kind-lists and no-hand-role-lists find the registry from the rule file, not the working directory (L2)', () => {
    // Run from another directory the rules once read no enum and no source
    // and passed everything; now they read this repo's wherever ESLint runs.
    const reports: unknown[] = [];
    const context = (code: string) => ({
      filename: '/elsewhere/packages/content/src/new.ts',
      cwd: '/',
      sourceCode: { getText: () => code },
      report: (r: unknown) => reports.push(r),
    });
    noHandKindLists.create(context("const K = ['page', 'note', 'draw'];")).Program();
    noHandRoleLists.create(context("const R = ['admin', 'member'];")).Program();
    expect(reports).toHaveLength(2);
  });

  it('no-hand-role-lists: a hand role list fails outside its source file', () => {
    const src = (ROLE_NAME_SOURCES as Record<string, { file: string }>).loginRole!.file;
    const list = "export const R = ['admin', 'member'];";
    tester.run('no-hand-role-lists', noHandRoleLists, {
      valid: [
        { code: list, filename: `/r/${src}` },
        { code: list, filename: '/r/packages/content/src/new.test.ts' },
        { code: "if (r === 'admin') x();", filename: '/r/packages/content/src/new.ts' },
      ],
      invalid: [
        {
          code: list,
          filename: '/r/packages/content/src/new.ts',
          errors: [{ messageId: 'list', line: 1, column: 18 }],
        },
        {
          code: "const ok = (v) => v === 'admin' || v === 'member';",
          filename: '/r/server/web/lib/new.ts',
          errors: [{ messageId: 'list', line: 1, column: 19 }],
        },
        {
          code: "const ok = (v) => ['owner', 'admin', 'member'].includes(v);",
          filename: '/r/server/web/lib/new.ts',
          errors: [{ messageId: 'superset' }],
        },
      ],
    });
  });

  it('store-brokers: a store write API outside its broker fails; the broker, a reader and a test pass', () => {
    tester.run('store-brokers', storeBrokersRule, {
      valid: [
        {
          code: "import { writeDocFile } from '@mantle/tabledb/write';",
          filename: '/r/packages/content/src/table-broker.ts',
        },
        {
          code: "import { readDocClipped } from '@mantle/tabledb';",
          filename: '/r/packages/content/src/tables/read.ts',
        },
        {
          code: "import { getContent } from '@mantle/storage';",
          filename: '/r/server/web/lib/new-reader.ts',
        },
        {
          code: "import { writeDocFile } from '@mantle/tabledb/write';",
          filename: '/r/packages/content/src/tables/draft.test.ts',
        },
        {
          code: "// import { putContent } from '@mantle/storage/write';\nconst a = 1;",
          filename: '/r/packages/files/src/ops/files.ts',
        },
      ],
      invalid: [
        {
          code: "import { writeDocFile } from '@mantle/tabledb/write';",
          filename: '/r/packages/content/src/tables/draft.ts',
          errors: [{ messageId: 'unpinned' }],
        },
        {
          code: "import { putContent } from '@mantle/storage/write';",
          filename: '/r/packages/files/src/ops/files.ts',
          errors: [{ messageId: 'unpinned' }],
        },
        {
          code: "import { runAppSqlBatch, AppSqlError } from './app-sql-runner';",
          filename: '/r/packages/content/src/app-viewer.ts',
          errors: [{ messageId: 'unpinned' }],
        },
      ],
    });
  });

  it('store-brokers: fsWritesIn finds named and namespace writes, not reads', () => {
    expect(
      fsWritesIn(
        "import { readFile, writeFile as w } from 'node:fs/promises';\nimport * as fs from 'node:fs';\nfs.rmSync(x); fs.existsSync(y);",
      ),
    ).toEqual(['rmSync', 'writeFile']);
    expect(fsWritesIn("import { readFile, stat } from 'node:fs/promises';")).toEqual([]);
  });

  it('flag the actor settings outside packages/db, and none there, in a test or a comment', () => {
    tester.run('actor-setters-in-db-only', actorSettersRule, {
      valid: [
        { code: "q('select mantle_set_actor($1, $2)');", filename: '/r/packages/db/src/client.ts' },
        { code: "q(`set_config('mantle.actor', x)`);", filename: '/r/server/web/x.test.ts' },
        { code: '// mantle.write_mode\nconst b = 1;', filename: '/r/packages/search/src/new.ts' },
      ],
      invalid: [
        {
          code: "q(`select set_config('mantle.actor', ${a}, true)`);",
          filename: '/r/packages/search/src/new.ts',
          errors: [{ messageId: 'notHere' }],
        },
        {
          code: "q('select mantle_operator_actor($1)');",
          filename: '/r/server/web/lib/x.ts',
          errors: [{ messageId: 'notHere' }],
        },
      ],
    });
  });
});
