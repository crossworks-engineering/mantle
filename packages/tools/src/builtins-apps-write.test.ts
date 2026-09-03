/**
 * Behavioural tests for the app AUTHORING writes: app_create, app_file_write,
 * app_source_set, app_tools_set, app_table_export_set.
 *
 * What is worth pinning here is the ordering of guard and store: every one of
 * these tools validates its input, then writes, and the write must not happen
 * when validation failed. The interesting cases are the ones where a sloppy
 * implementation would still "succeed":
 *
 *  - `app_source_set` replaces the WHOLE draft tree. An entry path that is not
 *    among the files would save a tree that can never build, so that check
 *    has to run before saveDraftSource and not after.
 *  - `app_tools_set` IS the runtime allowlist for host.tools.call. A slug the
 *    owner does not have must fail the whole call rather than be dropped, or
 *    the app ships declaring a capability that silently never resolves.
 *  - `app_create` records an ingest under the new node so the app shows up in
 *    the biography; the store call is owner-scoped like every other write.
 *
 * Store edges are stubbed; the tools' own coercion, guards and error mapping
 * are real, and the size-limit refusal runs through the real
 * AppSourceLimitError class.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    createApp: vi.fn(),
    writeDraftFile: vi.fn(),
    saveDraftSource: vi.fn(),
    setManifest: vi.fn(),
  };
});
vi.mock('@mantle/content/app-table-exports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/app-table-exports')>();
  return { ...actual, createAppTableExport: vi.fn(), scheduleAppTableExportSync: vi.fn() };
});
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn() }));
vi.mock('./resolve', () => ({ resolveTool: vi.fn(), resolveTools: vi.fn() }));

import {
  createApp,
  writeDraftFile,
  saveDraftSource,
  setManifest,
  AppSourceLimitError,
} from '@mantle/content';
import { createAppTableExport } from '@mantle/content/app-table-exports';
import { recordIngest } from '@mantle/tracing';
import { resolveTool } from './resolve';
import { APP_TOOLS } from './builtins-apps';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const create = APP_TOOLS.find((t) => t.slug === 'app_create')!;
const fileWrite = APP_TOOLS.find((t) => t.slug === 'app_file_write')!;
const sourceSet = APP_TOOLS.find((t) => t.slug === 'app_source_set')!;
const toolsSet = APP_TOOLS.find((t) => t.slug === 'app_tools_set')!;
const exportSet = APP_TOOLS.find((t) => t.slug === 'app_table_export_set')!;

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const APP_ID = '11111111-2222-4333-8444-555555555555';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const NEW_APP = {
  id: APP_ID,
  title: 'Weather',
  source: { entry: 'App.tsx', files: { 'App.tsx': 'export default function App() {}' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks clears CALLS, not implementations: re-set every default.
  vi.mocked(createApp).mockResolvedValue(NEW_APP as never);
  vi.mocked(writeDraftFile).mockResolvedValue({
    entry: 'App.tsx',
    files: { 'App.tsx': 'a', 'lib/fmt.ts': 'b' },
  } as never);
  vi.mocked(saveDraftSource).mockResolvedValue(true as never);
  vi.mocked(setManifest).mockResolvedValue({ toolSlugs: [] } as never);
  vi.mocked(resolveTool).mockResolvedValue({ slug: 'x' } as never);
  vi.mocked(createAppTableExport).mockResolvedValue({
    export: {},
    tableId: 'tbl-1',
    rows: 12,
    created: true,
  } as never);
});

describe('app_create', () => {
  it('refuses a blank name WITHOUT touching the store', async () => {
    expect(errorOf(await create.handler({ name: '   ' }, ctx))).toMatch(/name is required/);
    expect(createApp).not.toHaveBeenCalled();
    expect(recordIngest).not.toHaveBeenCalled();
  });

  it('creates under the caller, trimming and passing only the fields given', async () => {
    const res = await create.handler({ name: '  Weather  ', tags: ['work'] }, ctx);
    expect(createApp).toHaveBeenCalledWith('o1', { title: 'Weather', tags: ['work'] });
    // A blank icon/description must not be written as an empty string.
    const arg = vi.mocked(createApp).mock.calls[0]![1];
    expect(arg).not.toHaveProperty('icon');
    expect(arg).not.toHaveProperty('description');
    expect(outputOf(res)).toMatchObject({ id: APP_ID, name: 'Weather', entry: 'App.tsx' });
    expect(outputOf(res).url).toMatch(APP_ID);
  });

  it('passes icon and description through when present, capping the title', async () => {
    const long = 'x'.repeat(250);
    await create.handler({ name: long, icon: ' 🌤️ ', description: ' Forecasts ' }, ctx);
    expect(createApp).toHaveBeenCalledWith('o1', {
      title: 'x'.repeat(200),
      icon: '🌤️',
      description: 'Forecasts',
      tags: [],
    });
  });

  it('records the ingest against the NEW node, owner-scoped', async () => {
    await create.handler({ name: 'Weather' }, ctx);
    expect(recordIngest).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'agent_tool', ownerId: 'o1', nodeId: APP_ID }),
    );
  });

  it('surfaces a store failure instead of reporting success', async () => {
    vi.mocked(createApp).mockRejectedValue(new Error('db down'));
    expect(errorOf(await create.handler({ name: 'Weather' }, ctx))).toBe('db down');
    expect(recordIngest).not.toHaveBeenCalled();
  });
});

describe('app_file_write', () => {
  it('requires id and path, and writes nothing without them', async () => {
    expect(errorOf(await fileWrite.handler({ id: APP_ID, content: 'x' }, ctx))).toMatch(
      /id and path are required/,
    );
    expect(errorOf(await fileWrite.handler({ path: 'App.tsx', content: 'x' }, ctx))).toMatch(
      /id and path are required/,
    );
    expect(writeDraftFile).not.toHaveBeenCalled();
  });

  it('writes the file into the DRAFT under the caller and reports the tree size', async () => {
    const res = await fileWrite.handler(
      { id: APP_ID, path: ' lib/fmt.ts ', content: 'export const x = 1;' },
      ctx,
    );
    expect(writeDraftFile).toHaveBeenCalledWith('o1', APP_ID, 'lib/fmt.ts', 'export const x = 1;');
    expect(outputOf(res)).toMatchObject({
      id: APP_ID,
      path: 'lib/fmt.ts',
      file_count: 2,
      draft_saved: true,
    });
  });

  it('reports a missing app rather than a silent no-op', async () => {
    vi.mocked(writeDraftFile).mockResolvedValue(null as never);
    expect(
      errorOf(await fileWrite.handler({ id: APP_ID, path: 'a.ts', content: '' }, ctx)),
    ).toMatch(/not found/);
  });

  it('surfaces the size-limit refusal with its reason intact', async () => {
    vi.mocked(writeDraftFile).mockRejectedValue(
      new AppSourceLimitError('file too large (300000 bytes; max 262144)'),
    );
    expect(
      errorOf(await fileWrite.handler({ id: APP_ID, path: 'a.ts', content: 'x' }, ctx)),
    ).toMatch(/file too large/);
  });
});

describe('app_source_set', () => {
  const files = { 'App.tsx': 'export default function App() {}', 'util.ts': 'export {}' };

  it('requires id and entry, separately reported, before any write', async () => {
    expect(errorOf(await sourceSet.handler({ entry: 'App.tsx', files }, ctx))).toMatch(
      /id is required/,
    );
    expect(errorOf(await sourceSet.handler({ id: APP_ID, files }, ctx))).toMatch(
      /entry is required/,
    );
    expect(saveDraftSource).not.toHaveBeenCalled();
  });

  it('refuses a files value that is not a path map', async () => {
    expect(
      errorOf(await sourceSet.handler({ id: APP_ID, entry: 'App.tsx', files: ['a'] }, ctx)),
    ).toMatch(/files must be an object/);
    expect(
      errorOf(await sourceSet.handler({ id: APP_ID, entry: 'App.tsx', files: 'App.tsx' }, ctx)),
    ).toMatch(/files must be an object/);
    expect(saveDraftSource).not.toHaveBeenCalled();
  });

  it('refuses a file whose contents are not a string, naming the file', async () => {
    const res = await sourceSet.handler(
      { id: APP_ID, entry: 'App.tsx', files: { 'App.tsx': 'ok', 'data.json': { a: 1 } } },
      ctx,
    );
    expect(errorOf(res)).toMatch(/'data\.json' contents must be a string/);
    expect(saveDraftSource).not.toHaveBeenCalled();
  });

  it('refuses an entry that is not among the files, listing what IS there', async () => {
    // Saving this would leave a draft that can never build.
    const res = await sourceSet.handler({ id: APP_ID, entry: 'Main.tsx', files }, ctx);
    expect(errorOf(res)).toMatch(/entry 'Main\.tsx' must be one of the files/);
    expect(errorOf(res)).toMatch(/App\.tsx, util\.ts/);
    expect(saveDraftSource).not.toHaveBeenCalled();
  });

  it('replaces the whole draft tree under the caller', async () => {
    const res = await sourceSet.handler({ id: APP_ID, entry: ' App.tsx ', files }, ctx);
    expect(saveDraftSource).toHaveBeenCalledWith('o1', APP_ID, { entry: 'App.tsx', files });
    expect(outputOf(res)).toMatchObject({
      id: APP_ID,
      entry: 'App.tsx',
      file_count: 2,
      draft_saved: true,
    });
  });

  it('reports a missing app as a failure', async () => {
    vi.mocked(saveDraftSource).mockResolvedValue(false as never);
    expect(errorOf(await sourceSet.handler({ id: APP_ID, entry: 'App.tsx', files }, ctx))).toMatch(
      /not found/,
    );
  });

  it('surfaces the size-limit refusal with its reason intact', async () => {
    vi.mocked(saveDraftSource).mockRejectedValue(
      new AppSourceLimitError('too many files (51; max 50)'),
    );
    expect(errorOf(await sourceSet.handler({ id: APP_ID, entry: 'App.tsx', files }, ctx))).toMatch(
      /too many files/,
    );
  });
});

describe('app_tools_set', () => {
  it('refuses a blank id before resolving anything', async () => {
    expect(errorOf(await toolsSet.handler({ id: ' ', tool_slugs: ['a'] }, ctx))).toMatch(
      /id is required/,
    );
    expect(resolveTool).not.toHaveBeenCalled();
    expect(setManifest).not.toHaveBeenCalled();
  });

  it('fails the WHOLE call on an unknown slug, naming every miss, and writes nothing', async () => {
    // Dropping the bad ones and saving the rest would ship an allowlist the
    // model thinks is complete. The manifest must stay as it was.
    vi.mocked(resolveTool).mockImplementation(async (_owner, slug) =>
      slug === 'good' ? ({ slug } as never) : null,
    );
    const res = await toolsSet.handler({ id: APP_ID, tool_slugs: ['good', 'bad', 'worse'] }, ctx);
    expect(errorOf(res)).toMatch(/unknown tool slug\(s\): bad, worse/);
    expect(setManifest).not.toHaveBeenCalled();
  });

  it('resolves each slug against the CALLER and stores the list as the allowlist', async () => {
    const res = await toolsSet.handler({ id: APP_ID, tool_slugs: ['geocode', 'weather'] }, ctx);
    expect(resolveTool).toHaveBeenCalledWith('o1', 'geocode');
    expect(resolveTool).toHaveBeenCalledWith('o1', 'weather');
    expect(setManifest).toHaveBeenCalledWith('o1', APP_ID, { toolSlugs: ['geocode', 'weather'] });
    expect(outputOf(res)).toEqual({ id: APP_ID, tool_slugs: ['geocode', 'weather'] });
  });

  it('accepts an empty list, which clears the allowlist', async () => {
    await toolsSet.handler({ id: APP_ID, tool_slugs: [] }, ctx);
    expect(resolveTool).not.toHaveBeenCalled();
    expect(setManifest).toHaveBeenCalledWith('o1', APP_ID, { toolSlugs: [] });
  });

  it('reports a missing app as a failure', async () => {
    vi.mocked(setManifest).mockResolvedValue(null as never);
    expect(errorOf(await toolsSet.handler({ id: APP_ID, tool_slugs: ['geocode'] }, ctx))).toMatch(
      /not found/,
    );
  });
});

describe('app_table_export_set', () => {
  it('requires both arguments, separately reported, before any store call', async () => {
    expect(errorOf(await exportSet.handler({ table: 'tasks' }, ctx))).toMatch(/id is required/);
    expect(errorOf(await exportSet.handler({ id: APP_ID }, ctx))).toMatch(/table is required/);
    expect(createAppTableExport).not.toHaveBeenCalled();
  });

  it('creates the link under the caller and reports the new Table', async () => {
    const res = await exportSet.handler(
      { id: APP_ID, table: ' tasks ', title: ' Live tasks ' },
      ctx,
    );
    expect(createAppTableExport).toHaveBeenCalledWith('o1', APP_ID, 'tasks', {
      title: 'Live tasks',
    });
    expect(outputOf(res)).toMatchObject({ table_id: 'tbl-1', rows: 12, created: true });
    expect(outputOf(res).hint).toMatch(/now mirrors/);
  });

  it('passes no title when none was given, so the store picks its default', async () => {
    await exportSet.handler({ id: APP_ID, table: 'tasks' }, ctx);
    expect(createAppTableExport).toHaveBeenCalledWith('o1', APP_ID, 'tasks', { title: undefined });
  });

  it('says a re-sync happened when the link already existed', async () => {
    vi.mocked(createAppTableExport).mockResolvedValue({
      export: {},
      tableId: 'tbl-1',
      rows: 12,
      created: false,
    } as never);
    const out = outputOf(await exportSet.handler({ id: APP_ID, table: 'tasks' }, ctx));
    expect(out.created).toBe(false);
    expect(out.hint).toMatch(/already existed/);
  });

  it('surfaces a store failure instead of reporting success', async () => {
    vi.mocked(createAppTableExport).mockRejectedValue(new Error('app not found'));
    expect(errorOf(await exportSet.handler({ id: APP_ID, table: 'tasks' }, ctx))).toBe(
      'app not found',
    );
  });
});
