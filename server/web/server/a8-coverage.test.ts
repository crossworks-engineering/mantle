/**
 * The A8 coverage (plan v3.2 section 5 item 4: kinds, tools and routes), no
 * database: every registry kind is in the grid or in A8_EXEMPT with a
 * reason; every tool is in a generated cell set (a8-tool-cells.ts, from its
 * matrix declaration) or exempt (its declaration is `none`, with a reason);
 * every write route that names its item (`item: { param, need }`) is in the
 * route cells (a8-route-cells.ts) or runs its refused cells only, with why
 * (exempt), and its declared need is the one its cells ask; a write that
 * declares none and names an item in its path (`item: { none, param }`) is
 * in the route cells by the guide action it is, or exempt by its reason,
 * as a tool that declares none. What is in neither is uncovered, and so is
 * a tool or a route whose cells hold no allowed cell or no refused one.
 *
 * Two pins in scripts/arch-scoreboard.pins.json: a8Uncovered (only down)
 * and a8Exempt (the count of the names below; a new exemption is reviewed
 * by the final audit, named here and raises the cap with a note). The tool
 * cells run with a database in a8-tool-cells.matrix.test.ts, planned from
 * the same tool list (a8-tools.list.ts); this test also holds their size to
 * a ceiling (the budget: pairwise keeps it bounded).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ITEM_KINDS, ITEM_KIND_NAMES } from '@mantle/client-types/kinds';
import { A8_KINDS } from '@mantle/db/matrix/a8-grid';
import {
  A8_EXEMPT,
  A8_TOOL_MODES,
  A8_TOOL_SURFACES,
  a8ToolDecl,
  a8ToolPlan,
  a8UncoveredKinds,
} from '@mantle/db/matrix/a8-tool-cells';
import { a8RoutePlan, A8_ROUTE_MODES, type A8ManifestEntry } from './test-support/a8-route-cells';
import { a8AllTools } from './a8-tools.list';
import { routeManifest } from './route-manifest.gen';

const PINS = join(__dirname, '../../../scripts/arch-scoreboard.pins.json');

/** The tool cells' size ceiling: cells x ways in x check modes. A new tool
 *  adds its pairwise cells; past this the matrix run is too slow for CI. */
const A8_TOOL_RUN_CEILING = 9000;

/** The route cells' size ceiling: cells x check modes (each a request, a
 *  hidden one two). */
const A8_ROUTE_RUN_CEILING = 3000;

/** The A8 counts (a8Uncovered, a8Exempt), and what makes them. */
function a8Counts() {
  const plan = a8ToolPlan(a8AllTools().map(a8ToolDecl));
  const routes = a8RoutePlan(routeManifest as readonly A8ManifestEntry[]);
  const kindsUncovered = a8UncoveredKinds();
  return {
    plan,
    routes,
    kindsUncovered,
    a8Uncovered:
      Object.keys(plan.uncovered).length +
      kindsUncovered.length +
      Object.keys(routes.uncovered).length,
    a8Exempt:
      Object.keys(plan.exempt).length +
      Object.keys(A8_EXEMPT).length +
      Object.keys(routes.exempt).length,
  };
}

describe('A8 coverage: every kind, tool and item route is in a cell set or exempt', () => {
  const counts = a8Counts();

  it('every registry kind is in the grid or exempt with a reason', () => {
    expect(counts.kindsUncovered).toEqual([]);
    for (const [kind, why] of Object.entries(A8_EXEMPT)) {
      expect(ITEM_KIND_NAMES, kind).toContain(kind);
      expect(A8_KINDS, kind).not.toContain(kind);
      expect(why.trim(), kind).not.toBe('');
    }
  });

  it('every tool with a matrix action has cells, an allowed and a refused one, and each write its member-negatives', () => {
    expect(counts.plan.uncovered).toEqual({});
    for (const tool of counts.plan.covered) {
      // One for its own declaration, and one for a copy's destination.
      for (const dest of [false, true]) {
        const ofIt = counts.plan.cells.filter((c) => c.tool === tool && !!c.source === dest);
        if (dest && !ofIt.length) continue;
        const positive = ofIt.filter((c) => c.positive);
        expect(positive.length, `${tool}${dest ? ' dest' : ''}: its one positive cell`).toBe(1);
      }
    }
    // The writes by their effect: a copy declares the read of its source.
    const writes = new Set(
      counts.plan.cells
        .filter((c) => c.effect === 'write' || !['read', 'list', 'search'].includes(c.action))
        .map((c) => c.tool),
    );
    for (const tool of writes) {
      const negatives = counts.plan.cells.filter((c) => c.tool === tool && c.mandatory);
      expect(negatives.length, `${tool}: its member-negative cells`).toBeGreaterThanOrEqual(2);
    }
  });

  it('every write route that names its item has cells, an allowed and a refused one', () => {
    expect(counts.routes.uncovered).toEqual({});
    // The need a route declares is the one its cells ask (a8NeedOf).
    expect(counts.routes.mismatched).toEqual({});
    // A spec of a route that names no item (or is gone) is a stale one.
    expect(counts.routes.stale).toEqual([]);
    for (const key of counts.routes.covered) {
      const ofIt = counts.routes.cells.filter((c) => c.key === key);
      // Member-negative (plan rule 5): the outsider and the read grant's
      // member are refused wherever they meet the item.
      for (const role of ['outsider', 'readGrant'] as const) {
        expect(
          ofIt.some((c) => c.role === role),
          `${key}: a ${role} cell`,
        ).toBe(true);
      }
    }
    // A hidden item answers as a random uuid: such cells exist.
    expect(counts.routes.cells.filter((c) => !c.reads).length).toBeGreaterThan(0);
  });

  it('a write that declares none and names an item in its path says its param', () => {
    // A param that holds an item's id by its name: a none route with one
    // says it (`item: { none, param }`), so the counts above see it.
    const ITEM_PARAM = /^(nodeId|itemId|refId|mapId|pageId|tableId|appId|fileId|folderId)$/;
    const unsaid: string[] = [];
    for (const e of routeManifest as readonly A8ManifestEntry[]) {
      for (const [method, p] of Object.entries(e.policy ?? {})) {
        if (!p.item || p.item.none === undefined || p.item.param !== undefined) continue;
        const params = e.pattern.split('/').filter((x) => x.startsWith(':'));
        if (params.some((x) => ITEM_PARAM.test(x.slice(1)))) unsaid.push(`${method} ${e.pattern}`);
      }
    }
    expect(unsaid).toEqual([]);
  });

  it('a write that declares none on a workspace kind’s item route says its param', () => {
    // An `:id` is any id: the guard above names it by the route's prefix.
    // A kind's item route (its content or /api/v1 prefix, then `:id`) that
    // declares none names its param, unless the kind is one the grid makes
    // no item of (A8_EXEMPT: an Admin-only kind, the one reason class).
    const prefixes = ITEM_KIND_NAMES.flatMap((kind) => {
      const r = (
        ITEM_KINDS as Record<string, { route: { content: string | null; v1: string | null } }>
      )[kind]!.route;
      return [r.content, r.v1].filter((p): p is string => !!p).map((p) => ({ kind, p }));
    });
    const unsaid: string[] = [];
    const byClass: string[] = [];
    for (const e of routeManifest as readonly A8ManifestEntry[]) {
      for (const [method, p] of Object.entries(e.policy ?? {})) {
        if (!p.item || p.item.none === undefined || p.item.param !== undefined) continue;
        const of = prefixes.find(
          (x) => e.pattern === `${x.p}/:id` || e.pattern.startsWith(`${x.p}/:id/`),
        );
        if (!of) continue;
        const key = `${method} ${e.pattern}`;
        if (A8_KINDS.includes(of.kind) || !(of.kind in A8_EXEMPT))
          unsaid.push(`${key} (${of.kind})`);
        else byClass.push(key);
      }
    }
    expect(unsaid).toEqual([]);
    // The guard reads `:id`: the Admin-only kinds' routes are the ones it
    // lets by, each by its class.
    expect(byClass.length).toBeGreaterThan(0);
  });

  it('the exempt tools, kinds and routes, by name', () => {
    expect(Object.keys(counts.plan.exempt).sort()).toEqual(A8_EXEMPT_TOOLS);
    expect(Object.keys(A8_EXEMPT).sort()).toEqual(A8_EXEMPT_KINDS);
    expect(Object.keys(counts.routes.exempt).sort()).toEqual(A8_EXEMPT_ROUTES);
  });

  it('the pins: a8Uncovered only down, a8Exempt at its cap', () => {
    const pins = JSON.parse(readFileSync(PINS, 'utf8')) as Record<string, number>;
    const msg = (key: 'a8Uncovered' | 'a8Exempt') =>
      `${key} is ${counts[key]}, pinned ${pins[key]}: lower the pin when it went down; ` +
      'a raise needs a review line from the final audit in _notes';
    expect(counts.a8Uncovered, msg('a8Uncovered')).toBe(pins.a8Uncovered);
    expect(counts.a8Exempt, msg('a8Exempt')).toBe(pins.a8Exempt);
  });

  it('the budget: the tool and route cells stay under their ceilings', () => {
    const runs = counts.plan.cells.length * A8_TOOL_SURFACES.length * A8_TOOL_MODES.length;
    expect(runs).toBeLessThanOrEqual(A8_TOOL_RUN_CEILING);
    const routeRuns = counts.routes.cells.length * A8_ROUTE_MODES.length;
    expect(routeRuns).toBeLessThanOrEqual(A8_ROUTE_RUN_CEILING);
  });
});

/** The write routes that name their item and run their refused cells only
 *  (each its reason in A8_ROUTE_SPECS), and the ones that declare none and
 *  name an item with no cells (each its reason in its route file), by name:
 *  a new one is named here with the final audit's review line in the pins'
 *  _notes, and a8Exempt rises with it. */
const A8_EXEMPT_ROUTES: readonly string[] = [
  'DELETE /api/workspaces/:id/resources/:kind/:refId',
  'PATCH /api/v1/pages/:id',
  'PATCH /api/workspaces/:id/resources/:kind/:refId',
  'POST /api/apps/:id/db-broker',
  'POST /api/apps/:id/tool-broker',
  'POST /api/files/files/:id',
  'POST /api/files/folders/:id',
  'POST /api/grants/:nodeId/embeds',
];

/** The tools that declare `none` (each its reason in its policy), by name: a
 *  new one is named here with the final audit's review line in the pins'
 *  _notes, and a8Exempt rises with it. */
const A8_EXEMPT_TOOLS: readonly string[] = [
  'access_get',
  'access_set',
  'agent_grant_tool_group',
  'agent_set_thinking_effort',
  'api_docs_set',
  'api_key_delete',
  'api_key_import',
  'api_key_set',
  'api_key_test',
  'api_skill_set',
  'api_tool_create',
  'api_tool_delete',
  'api_tool_test',
  'api_tool_update',
  'app_create',
  'app_undelete',
  'ask_as_responder',
  'ask_responder',
  'circuit_verify',
  'contact_create',
  'contact_delete',
  'contact_get',
  'contact_update',
  'email_get',
  'email_send',
  'entity_facts',
  'entity_mentions',
  'entity_neighbors',
  'event_create',
  'formula_create',
  'graph_path',
  'heartbeat_complete',
  'heartbeat_fire',
  'heartbeat_list',
  'heartbeat_snooze',
  'heartbeat_update_state',
  'journal_create',
  'journal_delete',
  'journal_get',
  'journal_resolve_gap',
  'journal_update',
  'location_save',
  'messenger_create',
  'messenger_mark_read',
  'messenger_send',
  'model_catalog',
  'model_pool_list',
  'model_pool_remove',
  'model_pool_set',
  'note_create',
  'office_to_pdf',
  'openrouter_benchmarks',
  'openrouter_rankings',
  'openrouter_task_classes',
  'page_from_journal',
  'pdf_render',
  'pdf_tools',
  'peer_call',
  'pending_approve',
  'pending_get',
  'pending_reject',
  'present_create',
  'recall_eval',
  'recall_revision_restore',
  'recipe_tool_create',
  'recipe_tool_test',
  'responder_turn_input',
  'responder_turn_record',
  'route_map',
  'run_append',
  'run_audit',
  'run_cancel',
  'run_plan',
  'run_state',
  'run_terminal',
  'sandbox_autostart',
  'sandbox_exec',
  'sandbox_export',
  'sandbox_mcp_call',
  'sandbox_publish',
  'sandbox_rm',
  'sandbox_stop',
  'screenshot_render',
  'secret_create',
  'set_timezone',
  'sheet_build',
  'synthesize_speech',
  'table_create',
  'table_from_text',
  'task_create',
  'telegram_edit',
  'telegram_mark_processed',
  'telegram_pair',
  'telegram_pending',
  'telegram_react',
  'telegram_send',
  'tool_group_ensure',
  'tree_item_place',
  'update_persona',
  'web_crawl',
  'web_fetch',
  'web_map',
  'web_search',
  'web_search_pro',
  'worker_group_ensure',
];

/** The registry kinds the grid makes no item of (A8_EXEMPT, by class). */
const A8_EXEMPT_KINDS: readonly string[] = [
  'contact',
  'documentation',
  'email',
  'email_thread',
  'journal',
  'location',
  'mantle_peer',
  'printer_project',
  'secret',
  'sermon',
  'telegram_message',
];
