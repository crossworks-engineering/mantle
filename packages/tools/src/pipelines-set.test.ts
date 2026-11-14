/**
 * `pipeline_set` and the state in the list (docs/pipelines.md), with no
 * Postgres: the built-ins gain one made-up `after` pipeline with an option
 * of each type, and the table is a stand-in that keeps what a set stored
 * (its one check of a value, checkOptions, is the real one). The real
 * table, the workspaces check and the route are proven on Postgres
 * (server/web/app/api/pipelines/pipelines-set-route.db.test.ts).
 *
 *  - A row carries its kind, the shape and tabs of an `after` pipeline, its
 *    attach list, and each option with its spec and the value in force.
 *  - The tool's policy is the route's area, systemWhole, and spends nothing;
 *    its input is `id`, `options` and `workspaces`.
 *  - A set is in the next list, inside the window the counts are kept for:
 *    the state is never kept, the counts are.
 *  - A refusal is the sentence of the check, and writes nothing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineManifest } from '@mantle/files';
import type { ToolHandlerContext } from './types';

const TEST_AFTER: PipelineManifest = {
  id: 'test-after',
  name: 'Test tags',
  version: '1.0.0',
  api: 1,
  source: 'builtin',
  start: 'upload',
  match: { ext: ['dxf'], after: 'drawing-v1' },
  produces: { tabs: ['Test tags'] },
  needs: { weight: 'light' },
  options: {
    min_len: { type: 'number', label: 'Shortest tag', default: 3, min: 1, max: 20 },
    keep_notes: { type: 'bool', label: 'Keep notes', default: false },
    not_tags: {
      type: 'words',
      label: 'Words that are never a tag',
      default: [],
      maxItems: 10,
      maxChars: 8,
    },
  },
} as unknown as PipelineManifest;

const h = vi.hoisted(() => ({
  stored: new Map<string, { options: Record<string, unknown>; workspaces: string[] | null }>(),
  sets: [] as { loginId: string | null; id: string; change: unknown }[],
  looks: 0,
}));

vi.mock('@mantle/files', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...real,
    BUILTIN_PIPELINES: [...real.BUILTIN_PIPELINES, TEST_AFTER],
    fileIdsWithDatabase: vi.fn(async () => {
      h.looks += 1;
      return [];
    }),
    fileDataRows: vi.fn(async () => []),
  };
});

vi.mock('@mantle/content/pipeline-state', async () => {
  const f = await import('@mantle/files');
  const stateOf = (m: PipelineManifest) => {
    const row = h.stored.get(m.id);
    const options = f.effectiveOptions(m, row?.options);
    return {
      workspaces: f.isAfterPipeline(m)
        ? (row?.workspaces ?? f.defaultState(m).workspaces)
        : ('all' as const),
      options,
      optionsHash: f.optionsHash(m, options),
      runs: 0,
      lastRunAt: null,
    };
  };
  return {
    pipelineStateOf: vi.fn(async (_owner: string, m: PipelineManifest) => stateOf(m)),
    setPipelineState: vi.fn(
      async (
        _owner: string,
        loginId: string | null,
        m: PipelineManifest,
        change: { options?: unknown; workspaces?: string[] },
      ) => {
        h.sets.push({ loginId, id: m.id, change });
        const checked = f.checkOptions(m, change.options ?? {});
        if (!checked.ok) return checked;
        const row = h.stored.get(m.id) ?? { options: {}, workspaces: null };
        h.stored.set(m.id, {
          options: { ...row.options, ...checked.values },
          workspaces: change.workspaces ?? row.workspaces,
        });
        return { ok: true, state: stateOf(m) };
      },
    ),
  };
});

const { listPipelines, pipeline_set, resetPipelineCounts, setPipeline } =
  await import('./pipelines');

const OWNER = '00000000-0000-4000-8000-000000000000';
const LOGIN = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const ctx = { ownerId: OWNER, surface: { kind: 'web', loginId: LOGIN } } as ToolHandlerContext;

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'mantle-pipelines-set-'));
  vi.stubEnv('MANTLE_FILES_ROOT', root);
  h.stored.clear();
  h.sets = [];
  h.looks = 0;
  resetPipelineCounts();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

const rowIn = async (id: string) =>
  (await listPipelines(OWNER)).pipelines.find((p) => p.id === id)!;

describe('the state in the list', () => {
  it('an after pipeline: its kind, shape, tabs, attach list and options with spec and value', async () => {
    const row = await rowIn('test-after');
    expect(row).toMatchObject({
      kind: 'after',
      after: 'drawing-v1',
      tabs: ['Test tags'],
      workspaces: [],
      reads: ['dxf'],
    });
    expect(row.options).toEqual([
      { name: 'min_len', spec: TEST_AFTER.options!.min_len, value: 3 },
      { name: 'keep_notes', spec: TEST_AFTER.options!.keep_notes, value: false },
      { name: 'not_tags', spec: TEST_AFTER.options!.not_tags, value: [] },
    ]);
  });

  it('a reader: used in every workspace, no shape read, no tabs', async () => {
    expect(await rowIn('sheet')).toMatchObject({
      kind: 'reader',
      after: null,
      tabs: [],
      workspaces: 'all',
      options: [],
    });
  });
});

describe('pipeline_set', () => {
  it("has the route's area, systemWhole, spends nothing, MCP only, and takes id, options, workspaces", () => {
    expect(pipeline_set.mcpOnly).toBe(true);
    expect(pipeline_set.policy).toMatchObject({
      matrix: { none: 'a pipeline is not an item' },
      effect: 'write',
      spends: 'none',
      scope: { area: 'settings', systemWhole: true },
      peerRisky: true,
      idempotent: true,
      recipe: { step: 'forbidden' },
      clientSourced: { kind: 'always', why: 'changes how files are read on this box' },
    });
    const schema = pipeline_set.inputSchema as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['id', 'options', 'workspaces']);
    expect(schema.required).toEqual(['id']);
    // How an Admin switches an `after` pipeline off.
    expect(pipeline_set.description).toContain('`[]` switches it off');
  });

  it('a set is in the next list, while the counts are still kept', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await rowIn('test-after');
    expect(first.options.find((o) => o.name === 'min_len')!.value).toBe(3);
    expect(h.looks).toBe(1);

    const out = await pipeline_set.handler(
      { id: 'test-after', options: { min_len: 5, not_tags: ['rev', 'NOTE', 'rev'] } },
      ctx,
    );
    expect(out.ok).toBe(true);
    const row = (out as { output: import('@mantle/client-types').PipelineRow }).output;
    expect(row.options.map((o) => [o.name, o.value])).toEqual([
      ['min_len', 5],
      ['keep_notes', false],
      ['not_tags', ['NOTE', 'REV']],
    ]);
    // The row of a set carries no counts.
    expect([row.files, row.older]).toEqual([null, null]);
    // The acting login is recorded.
    expect(h.sets).toEqual([
      {
        loginId: LOGIN,
        id: 'test-after',
        change: { options: { min_len: 5, not_tags: ['rev', 'NOTE', 'rev'] } },
      },
    ]);

    // Inside the counts' window: the counts are not looked at again, the
    // state is the new one.
    const next = await rowIn('test-after');
    expect(h.looks).toBe(1);
    expect(next.options).toEqual(row.options);
    expect(next.files).toBe(0);

    await pipeline_set.handler({ id: 'test-after', workspaces: [WS] }, ctx);
    expect((await rowIn('test-after')).workspaces).toEqual([WS]);
    // [] switches it off.
    await pipeline_set.handler({ id: 'test-after', workspaces: [] }, ctx);
    expect((await rowIn('test-after')).workspaces).toEqual([]);
    expect(h.looks).toBe(1);
  });

  it('the tool and the route function give the same row', async () => {
    const viaTool = await pipeline_set.handler({ id: 'test-after', options: { min_len: 7 } }, ctx);
    const viaRoute = await setPipeline(OWNER, LOGIN, 'test-after', { options: { min_len: 7 } });
    expect(viaRoute.ok).toBe(true);
    expect(viaTool).toEqual({ ok: true, output: (viaRoute as { row: unknown }).row });
  });

  it('a bad option is refused with the sentence of checkOptions, and nothing is stored', async () => {
    const out = await pipeline_set.handler({ id: 'test-after', options: { min_len: 99 } }, ctx);
    expect(out).toEqual({ ok: false, error: 'Option "min_len" must be a number from 1 to 20.' });
    const unknown = await pipeline_set.handler({ id: 'sheet', options: { min_len: 5 } }, ctx);
    expect(unknown).toEqual({ ok: false, error: 'Spreadsheet has no option "min_len".' });
    expect(h.stored.size).toBe(0);
  });

  it('an unknown pipeline is refused before any set', async () => {
    expect(await pipeline_set.handler({ id: 'no-such', options: {} }, ctx)).toEqual({
      ok: false,
      error: 'There is no pipeline "no-such". Find the id with pipeline_list.',
    });
    expect(await setPipeline(OWNER, LOGIN, 'no-such', {})).toMatchObject({ missing: true });
    expect(h.sets).toEqual([]);
  });
});
