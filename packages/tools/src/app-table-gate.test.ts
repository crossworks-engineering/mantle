/**
 * Apps and Tables: the 34 tools that can reach a Table are marked on their
 * definitions, and the one gate in appToolVerdict reads the mark, by a row's
 * builtin ref, on a box with MANTLE_NO_AUTO_TABLES. Team rules, a member's run
 * and a timer on Postgres: server/web/server/file-sql.db.test.ts and
 * app-timers/app-timers.db.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./resolve', () => ({ resolveTool: vi.fn(), resolveTools: vi.fn() }));

import { resolveTool, resolveTools } from './resolve';
import {
  appListReachesTables,
  appToolVerdict,
  toolReachesTables,
  type AppToolVerdict,
} from './app-tool-level';
import { appToolRunPlan } from './app-tool-run';
import { BUILTIN_TOOLS } from './builtins';
import { MCP_SURFACE_POLICIES } from './mcp-surface-policies';

const REACHES_TABLES = [
  'export_node',
  'node_read',
  'table_aggregate',
  'table_cell_set',
  'table_column_add',
  'table_column_delete',
  'table_column_update',
  'table_commit',
  'table_create',
  'table_delete',
  'table_from_file',
  'table_from_text',
  'table_get',
  'table_history',
  'table_list',
  'table_query',
  'table_row_add',
  'table_row_delete',
  'table_row_get',
  'table_row_update',
  'table_rows_add',
  'table_rows_list',
  'table_rows_upsert',
  'table_schema',
  'table_set_aggregate',
  'table_set_view',
  'table_snapshot_create',
  'table_snapshot_delete',
  'table_snapshot_restore',
  'table_sql',
  'table_tab_add',
  'table_tab_delete',
  'table_tab_rename',
  'table_update',
];

const builtinRow = (slug: string, ref = slug) =>
  ({ slug, enabled: true, handler: { kind: 'builtin', ref } }) as never;
const httpRow = (slug: string) =>
  ({
    slug,
    enabled: true,
    handler: { kind: 'http', url: 'https://example.test', method: 'GET' },
  }) as never;
const recipeRow = (slug: string) =>
  ({ slug, enabled: true, handler: { kind: 'recipe', steps: [{ tool: 'table_sql' }] } }) as never;

const rows = (...list: never[]) => {
  const bySlug = new Map(list.map((r) => [(r as { slug: string }).slug, r]));
  vi.mocked(resolveTool).mockImplementation(async (_o, slug) => bySlug.get(slug) ?? null);
  vi.mocked(resolveTools).mockImplementation(async (_o, slugs) =>
    slugs.flatMap((s) => (bySlug.has(s) ? [bySlug.get(s)!] : [])),
  );
};

const refusal = (v: AppToolVerdict) => (v.ok ? null : v.reason);

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the mark', () => {
  it('sits on exactly the 34 tools, read from the registry', () => {
    const marked = BUILTIN_TOOLS.filter((t) => t.policy.reachesTables === true)
      .map((t) => t.slug)
      .sort();
    expect(marked).toEqual(REACHES_TABLES);
    expect(marked).toHaveLength(34);
  });

  it('covers every table_ tool, and only those two beside them', () => {
    const tableTools = BUILTIN_TOOLS.filter((t) => t.slug.startsWith('table_'));
    expect(tableTools).toHaveLength(32);
    for (const t of tableTools) expect(t.policy.reachesTables, t.slug).toBe(true);
  });

  it('a table twin on the MCP surface holds it too', () => {
    for (const [slug, policy] of Object.entries(MCP_SURFACE_POLICIES)) {
      if (slug.startsWith('table_')) {
        expect((policy as { reachesTables?: true }).reachesTables, slug).toBe(true);
      }
    }
  });

  it('file_sql and dwg_render are not marked: they read no Table', () => {
    for (const slug of ['file_sql', 'dwg_render', 'circuit_trace']) {
      expect(
        BUILTIN_TOOLS.find((t) => t.slug === slug)?.policy.reachesTables,
        slug,
      ).toBeUndefined();
    }
  });
});

describe('the helper the integrity count reads', () => {
  beforeEach(() => rows(builtinRow('my_alias', 'table_sql'), builtinRow('calculate')));

  it('a list holds one by slug, or by a row over one', async () => {
    expect(await appListReachesTables('o', ['calculate', 'table_sql'])).toBe(true);
    expect(await appListReachesTables('o', ['calculate', 'my_alias'])).toBe(true);
    expect(await appListReachesTables('o', ['calculate', 'file_sql'])).toBe(false);
    expect(await appListReachesTables('o', [])).toBe(false);
  });

  it('a slug with no row still counts, a row by its ref', async () => {
    expect(await toolReachesTables('node_read')).toBe(true);
    expect(await toolReachesTables('x', builtinRow('x', 'export_node'))).toBe(true);
    expect(await toolReachesTables('x', httpRow('x'))).toBe(false);
    expect(await toolReachesTables('x', recipeRow('x'))).toBe(false);
  });
});

describe('the gate at admin rules', () => {
  const DECLARED = ['table_sql', 'my_alias', 'node_read', 'calculate', 'my_http', 'my_recipe'];
  const verdict = (slug: string) => appToolVerdict('admin', 'o', DECLARED, slug);

  beforeEach(() =>
    rows(
      builtinRow('table_sql'),
      builtinRow('my_alias', 'table_row_add'),
      builtinRow('node_read'),
      builtinRow('calculate'),
      httpRow('my_http'),
      recipeRow('my_recipe'),
    ),
  );

  it('without the line a declared Table tool still runs', async () => {
    for (const slug of DECLARED) expect((await verdict(slug)).ok, slug).toBe(true);
  });

  it('with the line a declared Table tool, or an alias of one, is refused in plain words', async () => {
    vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
    for (const slug of ['table_sql', 'my_alias', 'node_read']) {
      const v = await verdict(slug);
      expect(v, slug).toMatchObject({ ok: false, status: 403 });
      expect(refusal(v), slug).toContain(`'${slug}'`);
      expect(refusal(v), slug).toContain('file_sql');
    }
  });

  it('with the line every other tool runs, a recipe and an http tool too', async () => {
    vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
    for (const slug of ['calculate', 'my_http', 'my_recipe']) {
      expect((await verdict(slug)).ok, slug).toBe(true);
    }
  });

  it('a yes comes first: an undeclared slug and a missing row keep their own answers', async () => {
    vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
    const undeclared = await appToolVerdict('admin', 'o', ['calculate'], 'table_sql');
    expect(refusal(undeclared)).toContain('must be declared');
    const missing = await appToolVerdict('admin', 'o', ['table_get'], 'table_get');
    expect(missing).toMatchObject({ ok: false, status: 404 });
  });

  it('reads no input: an id cannot get past it, through the one plan', async () => {
    vi.stubEnv('MANTLE_NO_AUTO_TABLES', '1');
    const plan = appToolRunPlan(
      { via: 'owner', ownerId: 'o', runner: { loginId: 'l', name: 'Ada' } },
      { id: 'a', manifest: { toolSlugs: DECLARED }, toolRules: 'admin' },
      'node_read',
      { node_id: 'an-ordinary-page' },
    );
    expect(plan.rules).toBe('admin');
    expect(await plan.verdict()).toMatchObject({ ok: false, status: 403 });
  });
});
