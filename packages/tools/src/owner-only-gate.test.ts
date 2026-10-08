/**
 * The owner-only gate (client logins C4, plan section 8, tests 15).
 *
 * Before C4 each owner-only tool refused `surface.kind === 'team'` inline and
 * let everything else through, so a client, or any caller that forgot its
 * surface, was treated as the owner. The check is now an allowlist
 * (`isOwnerSurface`), enforced centrally in dispatchTool for every builtin
 * marked `ownerOnly`, and still inline in each handler (the MCP server calls
 * `def.handler` directly). These pin:
 *   - the exact ownerOnly set, so dropping a flag fails;
 *   - dispatchTool refuses client, team and a missing surface with
 *     OWNER_ONLY_ERROR before preconditions and the handler;
 *   - web, telegram and every `owner` path pass the gate;
 *   - each handler refuses on its own too (the MCP path);
 *   - a recipe's steps inherit the recipe's surface;
 *   - no owner check in the package still tests for `kind === 'team'`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pre: vi.fn(async () => null),
  resolveTool: vi.fn(),
}));
vi.mock('./preconditions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkToolPreconditions: h.pre,
}));
vi.mock('./resolve', () => ({ resolveTool: h.resolveTool, resolveTools: vi.fn() }));

import type { Tool } from '@mantle/db';
import { dispatchTool } from './dispatch';
import { getBuiltin, listBuiltins, registerBuiltin } from './registry';
import { PAGE_TOOLS } from './builtins-pages';
import { isOwnerSurface, OWNER_ONLY_ERROR } from './surface';
import type { BuiltinToolDef, OwnerSurfaceVia, ToolHandlerContext } from './types';

type Surface = ToolHandlerContext['surface'];

/** Every builtin that runs only for the owner. Adding a flag means adding it
 *  here; dropping one fails the first test. */
const EXPECTED_OWNER_ONLY = [
  'access_get',
  'access_set',
  // The app write tools (client tier audit I8).
  'app_build',
  'app_create',
  'app_db_schema_set',
  'app_db_seed',
  'app_delete',
  'app_deleted_list',
  'app_duplicate',
  'app_errors',
  'app_export',
  'app_file_delete',
  'app_file_write',
  'app_import',
  'app_publish',
  'app_snapshot_create',
  'app_snapshot_delete',
  'app_snapshot_list',
  'app_snapshot_restore',
  'app_source_set',
  'app_table_export_remove',
  'app_table_export_set',
  'app_tools_set',
  'app_undelete',
  'app_update',
  'content_supersede',
  'model_catalog',
  'model_pool_remove',
  'model_pool_set',
  'openrouter_benchmarks',
  'openrouter_rankings',
  'openrouter_task_classes',
  // The owner's Recall acts on MCP (builtins-recall-owner.ts).
  // A page's folder is the tree's (folder phase 7): the owner files it,
  // like tree_item_move.
  'page_move',
  'recall_card_set_slug',
  'recall_cards_reorder',
  'recall_map_delete',
  'recall_map_get',
  'recall_map_publish',
  'recall_map_set_slug',
  'recall_pending',
  'recall_prompt_confirm',
  'recall_revision_restore',
  'recall_revisions',
  'table_history',
  'table_snapshot_create',
  'table_snapshot_delete',
  'table_snapshot_restore',
  'team_access_list',
  'team_chat_list',
  'team_chat_read',
  // The item tree's folders (builtins-tree.ts): members and clients browse a
  // pruned tree from phase 4; until then only the owner reorganises it.
  'tree_folder_create',
  'tree_folder_delete',
  'tree_folder_update',
  'tree_folders',
  'tree_item_move',
  'video_ingest',
  'web_crawl',
  'web_map',
];

const OWNER_VIAS: OwnerSurfaceVia[] = [
  'mcp',
  'run',
  'delegate',
  'pending',
  'dev-tools',
  'app',
  'recipe-test',
  'federation',
  'heartbeat',
];

const NOT_OWNER: Array<[string, Surface]> = [
  ['client', { kind: 'client', loginId: '00000000-0000-4000-8000-000000000001' }],
  ['team (member login)', { kind: 'team', loginId: '00000000-0000-4000-8000-000000000002' }],
  ['team (contact)', { kind: 'team', contactId: 'c1', privateReads: true }],
  ['missing', undefined],
];

const OWNER: Array<[string, Surface]> = [
  ['web', { kind: 'web' }],
  ['telegram', { kind: 'telegram', telegramChatId: '42' }],
  ...OWNER_VIAS.map((via): [string, Surface] => [`owner/${via}`, { kind: 'owner', via }]),
];

const row = (slug: string) =>
  ({ slug, handler: { kind: 'builtin', ref: slug }, requiresConfirm: false }) as unknown as Tool;

const ctxFor = (surface: Surface): ToolHandlerContext => ({
  ownerId: 'o1',
  ...(surface ? { surface } : {}),
});

describe('the ownerOnly set', () => {
  it('is exactly the pinned list', () => {
    const flagged = listBuiltins()
      .filter((d) => d.ownerOnly)
      .map((d) => d.slug)
      .sort();
    expect(flagged).toEqual(EXPECTED_OWNER_ONLY);
  });

  it('isOwnerSurface is an allowlist', () => {
    for (const [, s] of OWNER) expect(isOwnerSurface(s)).toBe(true);
    for (const [, s] of NOT_OWNER) expect(isOwnerSurface(s)).toBe(false);
  });
});

describe('dispatchTool gates every ownerOnly builtin', () => {
  // Swap each def's handler for a spy (same slug, same flags, same
  // preconditions), restoring the real def afterwards.
  const originals = new Map<string, BuiltinToolDef>();
  const spy = vi.fn(async () => ({ ok: true as const, output: 'ran' }));

  beforeEach(() => {
    spy.mockClear();
    h.pre.mockClear();
    for (const slug of EXPECTED_OWNER_ONLY) {
      const def = getBuiltin(slug)!;
      originals.set(slug, def);
      registerBuiltin({ ...def, handler: spy });
    }
  });
  afterEach(() => {
    for (const def of originals.values()) registerBuiltin(def);
  });

  for (const slug of EXPECTED_OWNER_ONLY) {
    describe(slug, () => {
      it.each(NOT_OWNER)(
        'refuses a %s surface before preconditions and the handler',
        async (_n, s) => {
          const res = await dispatchTool(row(slug), { node_id: 'x' }, ctxFor(s));
          expect(res).toEqual({ ok: false, error: OWNER_ONLY_ERROR });
          expect(spy).not.toHaveBeenCalled();
          expect(h.pre).not.toHaveBeenCalled();
        },
      );

      it.each(OWNER)('lets a %s surface through to the handler', async (_n, s) => {
        const res = await dispatchTool(row(slug), {}, ctxFor(s));
        expect(res).toEqual({ ok: true, output: 'ran' });
        expect(spy).toHaveBeenCalledOnce();
      });
    });
  }

  it('leaves a builtin without the flag alone on every surface', async () => {
    const def = getBuiltin('calculate')!;
    expect(def.ownerOnly).toBeUndefined();
    for (const [, s] of NOT_OWNER) {
      const res = await dispatchTool(row('calculate'), { expression: '1+1' }, ctxFor(s));
      expect(res.ok).toBe(true);
    }
  });
});

describe('each ownerOnly handler refuses on its own (the MCP path skips dispatch)', () => {
  for (const slug of EXPECTED_OWNER_ONLY) {
    it.each(NOT_OWNER)(`${slug} refuses a %s surface`, async (_n, s) => {
      const res = await getBuiltin(slug)!.handler({ node_id: 'x', url: 'x' }, ctxFor(s));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toMatch(/owner-side/);
    });
  }
});

describe('a recipe runs its steps for the recipe caller', () => {
  const spy = vi.fn(async () => ({ ok: true as const, output: 'ran' }));
  let original: BuiltinToolDef;
  beforeEach(() => {
    spy.mockClear();
    original = getBuiltin('access_get')!;
    registerBuiltin({ ...original, handler: spy });
    h.resolveTool.mockResolvedValue(row('access_get'));
  });
  afterEach(() => registerBuiltin(original));

  const recipe = {
    slug: 'r',
    handler: { kind: 'recipe', steps: [{ tool: 'access_get', input: {} }] },
  } as unknown as Tool;

  it.each(OWNER)('an owner (%s) recipe runs an owner-only step', async (_n, s) => {
    const res = await dispatchTool(recipe, {}, ctxFor(s));
    expect(res.ok).toBe(true);
    const calls = spy.mock.calls as unknown as Array<[unknown, ToolHandlerContext]>;
    expect(calls[0]![1].surface).toEqual(s);
  });

  it.each(NOT_OWNER)('a %s recipe cannot reach an owner-only step', async (_n, s) => {
    const res = await dispatchTool(recipe, {}, ctxFor(s));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain(OWNER_ONLY_ERROR);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── static: no owner check still keys on the team kind ──────────────────────

/** The only places in packages/tools/src allowed to compare a surface kind to
 *  'team', each for a reason other than "is this the owner". */
const TEAM_KIND_ALLOWED: Record<string, string[]> = {
  // team_request_create REQUIRES a team surface (positive check).
  'builtins-team.ts': ["if (surface?.kind !== 'team') {"],
  // The hidden-types team branch: privateReads applies to a team surface only.
  'team-visibility.ts': ["if (surface?.kind === 'team') {"],
  // Team-level apps for a team surface; client and missing reach none.
  'builtins-apps.ts': [
    "if (ctx.surface?.kind === 'team') return listTeamLevelAppIds(ctx.ownerId);",
  ],
  // my-space acts for the login on a team or client surface.
  'builtins-my-space.ts': [
    "const loginId = s?.kind === 'team' || s?.kind === 'client' ? s.loginId : undefined;",
  ],
  // App data on a login's own MCP (team apps Phase 1): a member on a team
  // surface, only with the MCP connection stamped.
  'builtins-app-data.ts': ["if (s?.kind === 'team' && s.loginId && s.mcp) {"],
  // A connector call below the owner runs at the level its surface names.
  'dispatch.ts': ["s?.kind === 'team'"],
  // Own-space drafts: a folder is for a member's space only (clients have none).
  'builtins-my-space-write.ts': ["if (ctx.surface?.kind !== 'team') {"],
  // read_result binds a client's or member's turn to its own spills.
  'builtins-tool-results.ts': ["if (kind !== 'client' && kind !== 'team') return undefined;"],
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('owner checks are allowlists', () => {
  it("no non-test source compares a surface kind to 'team' outside the allowlist", () => {
    const found: Record<string, string[]> = {};
    for (const file of sourceFiles(__dirname)) {
      const rel = relative(__dirname, file);
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const t = line.trim();
        if (t.startsWith('*') || t.startsWith('//')) continue;
        if (/kind\s*[!=]==?\s*['"]team['"]/.test(t)) (found[rel] ??= []).push(t);
      }
    }
    expect(found).toEqual(TEAM_KIND_ALLOWED);
  });
});

describe("filing a page in a folder is the owner's (folder phase 7)", () => {
  // These tools are not ownerOnly (a member's turn may make a page at the
  // top level), but folder_id, parent_id and confirm are refused on any
  // surface that is not the owner's, before any store call.
  const FOLDER = '00000000-0000-4000-8000-000000000009';
  const placed: Array<[string, Record<string, unknown>]> = [
    ['page_create', { title: 'x', folder_id: FOLDER }],
    ['page_create', { title: 'x', parent_id: FOLDER }],
    ['page_create', { title: 'x', confirm: true }],
    ['page_from_note', { note_id: FOLDER, folder_id: FOLDER }],
    ['page_from_notes', { note_ids: [FOLDER], folder_id: FOLDER }],
    ['page_from_journal', { entry_ids: [FOLDER], folder_id: FOLDER }],
    ['page_from_file', { file_id: FOLDER, folder_id: FOLDER }],
  ];
  for (const [slug, input] of placed) {
    for (const [name, surface] of NOT_OWNER) {
      it(`${slug} refuses ${JSON.stringify(input)} on a ${name} surface`, async () => {
        const def = (PAGE_TOOLS as readonly BuiltinToolDef[]).find((t) => t.slug === slug)!;
        const res = await def.handler(input, ctxFor(surface));
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toMatch(/owner's/);
      });
    }
  }
});
