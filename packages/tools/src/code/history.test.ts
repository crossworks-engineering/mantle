/**
 * The app history tools over a stubbed store: code_diff's sides (draft,
 * live, an entry by seq) and its cuts, app_log's page, and app_export's git
 * mode (the versions it reads, what each commit says, where it saves).
 * The bundle itself against real git is git-bundle.test.ts; the rights are
 * the DB lanes' (A8 tool cells, W7 sweeps).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, getApp: vi.fn() };
});
vi.mock('@mantle/content/app-snapshots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/app-snapshots')>();
  return {
    ...actual,
    appHistorySource: vi.fn(),
    appHistoryLine: vi.fn(),
    appVersionSources: vi.fn(),
  };
});
vi.mock('@mantle/content/app-package', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/app-package')>();
  return { ...actual, assertMayCopyApp: vi.fn() };
});
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return { ...actual, saveExport: vi.fn() };
});

import { getApp } from '@mantle/content';
import { assertMayCopyApp } from '@mantle/content/app-package';
import {
  appHistoryLine,
  appHistorySource,
  appVersionSources,
  type AppVersionSource,
} from '@mantle/content/app-snapshots';
import { saveExport } from '@mantle/files';
import { APP_TOOLS, versionAuthor, versionMessage } from '../builtins-apps';
import { OWNER_ONLY_ERROR } from '../surface';
import type { BuiltinToolDef, ToolHandlerContext } from '../types';
import { parseDiffRef } from './history';
import { CODE_TOOLS } from './tools';

const codeDiff = CODE_TOOLS.find((t) => t.slug === 'code_diff')!;
const appTool = (slug: string) => APP_TOOLS.find((t) => t.slug === slug)!;

const ctx: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'web' } };
const APP_ID = '11111111-2222-4333-8444-555555555555';
const TARGET = `app:${APP_ID}`;

const LIVE = {
  entry: 'App.tsx',
  files: { 'App.tsx': 'a\nb\nc\n', 'old.ts': 'gone\n', 'same.ts': 'same\n' },
};
const DRAFT = {
  entry: 'App.tsx',
  files: { 'App.tsx': 'a\nB\nc\n', 'new.ts': 'hi\n', 'same.ts': 'same\n' },
};

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;
const errorOf = (r: Result) => {
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.output)}`);
  return r.error;
};
const outputOf = (r: Result) => {
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r.output as Record<string, unknown>;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApp).mockResolvedValue({ title: 'My App', source: LIVE, draft: DRAFT } as never);
});

describe('parseDiffRef', () => {
  it('reads draft, live and a seq, and teaches anything else', () => {
    expect(parseDiffRef('', 'live')).toEqual({ kind: 'live' });
    expect(parseDiffRef(' Draft ', 'live')).toEqual({ kind: 'draft' });
    expect(parseDiffRef('published', 'draft')).toEqual({ kind: 'live' });
    for (const v of ['v3', '3', '#3', 'V3']) {
      expect(parseDiffRef(v, 'live')).toEqual({ kind: 'entry', seq: 3 });
    }
    for (const v of ['v0', 'head', 'v-1', '3.5', 'v1234567890']) {
      expect(parseDiffRef(v, 'live')).toMatchObject({ ok: false, error: expect.stringMatching(/must be/) });
    }
  });
});

describe('code_diff', () => {
  it('compares live to the draft by default, file by file', async () => {
    const out = outputOf(await codeDiff.handler({ target: TARGET }, ctx));
    expect(out).toMatchObject({
      target: TARGET,
      from: { ref: 'live' },
      to: { ref: 'draft' },
      changed: 3,
      unchanged: 1,
    });
    const files = out.files as { path: string; change: string; diff: string }[];
    expect(files.map((f) => [f.path, f.change])).toEqual([
      ['App.tsx', 'modified'],
      ['new.ts', 'added'],
      ['old.ts', 'removed'],
    ]);
    expect(files[0]!.diff).toContain('-b\n+B');
  });

  it('reads a history entry by seq, its published tree only', async () => {
    vi.mocked(appHistorySource).mockResolvedValue({
      seq: 3,
      trigger: 'publish',
      createdAt: '2026-10-01T00:00:00.000Z',
      source: { entry: 'App.tsx', files: { 'App.tsx': 'a\nx\nc\n' } },
    });
    const out = outputOf(
      await codeDiff.handler({ target: APP_ID, from: 'v3', to: 'live', path: './App.tsx' }, ctx),
    );
    expect(appHistorySource).toHaveBeenCalledWith('o1', APP_ID, 3);
    expect(out.from).toMatchObject({ ref: 'v3', seq: 3, trigger: 'publish' });
    expect(out.files).toEqual([
      expect.objectContaining({ path: 'App.tsx', diff: expect.stringContaining('-x\n+b') }),
    ]);
  });

  it('names an entry the line lacks, a file no side holds, and a bad ref', async () => {
    vi.mocked(appHistorySource).mockResolvedValue(null);
    expect(errorOf(await codeDiff.handler({ target: TARGET, from: 'v9' }, ctx))).toMatch(
      /no history entry v9: pick a seq that app_log lists/,
    );
    expect(errorOf(await codeDiff.handler({ target: TARGET, path: 'nope.ts' }, ctx))).toMatch(
      /no file 'nope.ts' in live or draft/,
    );
    expect(errorOf(await codeDiff.handler({ target: TARGET, to: 'tip' }, ctx))).toMatch(/must be/);
    expect(errorOf(await codeDiff.handler({ target: 'sandbox:x' }, ctx))).toMatch(
      /names no source tree: write app:<id>/,
    );
  });

  it('answers a missing app as not found, as code_view does', async () => {
    vi.mocked(getApp).mockResolvedValue(null);
    expect(errorOf(await codeDiff.handler({ target: TARGET }, ctx))).toMatch(/not found/);
  });

  it('says when there is no draft the caller sees', async () => {
    vi.mocked(getApp).mockResolvedValue({ title: 'A', source: LIVE, draft: null } as never);
    const out = outputOf(await codeDiff.handler({ target: TARGET }, ctx));
    expect(out).toMatchObject({ changed: 0, to: { ref: 'draft', no_draft: true } });
    expect(out.hint).toMatch(/no draft you can see/);
  });

  it('cuts a long answer and says how to see the rest', async () => {
    const many = (tag: string) =>
      Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [
          `f${String(i).padStart(2, '0')}.ts`,
          Array.from({ length: 300 }, (_, j) => `${tag} ${j}`).join('\n'),
        ]),
      );
    vi.mocked(getApp).mockResolvedValue({
      title: 'A',
      source: { entry: 'f00.ts', files: many('a') },
      draft: { entry: 'f00.ts', files: many('b') },
    } as never);
    const out = outputOf(await codeDiff.handler({ target: TARGET }, ctx));
    const files = out.files as { diff?: string; diff_omitted?: boolean }[];
    expect(files[0]!.diff).toMatch(/diff cut: \d+ more line\(s\); pass path for that one file/);
    expect(files.some((f) => f.diff_omitted)).toBe(true);
    expect(out.hint).toMatch(/listed without a diff/);
  });

  it('runs on the owner surfaces only (the history list gate)', async () => {
    expect(codeDiff.ownerOnly).toBe(true);
    expect(codeDiff.loginTurns).toBe(true);
    expect(codeDiff.policy).toEqual({
      ...appTool('app_snapshot_list').policy,
      matrix: { action: 'read', param: 'target', kinds: ['app'] },
    });
    const r = await codeDiff.handler({ target: TARGET }, { ownerId: 'o1', surface: { kind: 'client' } } as never);
    expect(errorOf(r)).toBe(OWNER_ONLY_ERROR);
    expect(getApp).not.toHaveBeenCalled();
  });
});

describe('app_log', () => {
  const log = appTool('app_log');

  it('has the history list gate', () => {
    const list = appTool('app_snapshot_list');
    expect(log.policy).toEqual(list.policy);
    expect([log.ownerOnly, log.loginTurns]).toEqual([list.ownerOnly, list.loginTurns]);
    expect(log.preconditions).toEqual(list.preconditions);
  });

  it('lists the row fields, with a ref per entry and the next page', async () => {
    vi.mocked(appHistoryLine).mockResolvedValue({
      lines: [
        {
          seq: 5,
          kind: 'version',
          trigger: 'publish',
          note: 'fix totals',
          actor: 'member',
          actorLoginId: 'l1',
          createdAt: '2026-10-02T00:00:00.000Z',
          fileCount: 3,
          sourceBytes: 900,
          hasData: false,
          dbBytes: null,
          restoredFrom: null,
        },
      ],
      more: true,
    });
    const out = outputOf(await log.handler({ id: APP_ID, limit: 999, before_seq: 9 }, ctx));
    expect(appHistoryLine).toHaveBeenCalledWith('o1', APP_ID, {
      limit: 200,
      beforeSeq: 9,
      versionsOnly: false,
    });
    expect(out.entries).toEqual([
      {
        seq: 5,
        ref: 'v5',
        kind: 'version',
        trigger: 'publish',
        note: 'fix totals',
        actor: 'member',
        actor_login_id: 'l1',
        at: '2026-10-02T00:00:00.000Z',
        files: 3,
        source_bytes: 900,
        has_data: false,
      },
    ]);
    expect(out).toMatchObject({ more: true, hint: expect.stringMatching(/before_seq 5/) });
  });
});

describe("app_export's git mode", () => {
  const exp = appTool('app_export');
  const version = (seq: number, files: Record<string, string>, more: Partial<AppVersionSource> = {}) => ({
    seq,
    note: null,
    actor: 'owner' as const,
    actorLoginId: null,
    createdAt: new Date(Date.UTC(2026, 9, seq)),
    restoredFrom: null,
    source: { entry: 'App.tsx', files },
    ...more,
  });
  async function* versions(list: AppVersionSource[]) {
    yield* list;
  }

  beforeEach(() => {
    vi.mocked(saveExport).mockResolvedValue({
      file: { id: 'f1', filename: 'my-app.bundle', parentPath: 'files', sizeBytes: 10 },
      landedIn: null,
    } as never);
  });

  it('asks the read a package without data asks, then saves one .bundle', async () => {
    vi.mocked(appVersionSources).mockReturnValue(
      versions([version(1, { 'App.tsx': 'a\n' }), version(3, { 'App.tsx': 'b\n' }, { note: 'two' })]),
    );
    const out = outputOf(await exp.handler({ id: APP_ID, format: 'git', with_data: true }, ctx));
    expect(assertMayCopyApp).toHaveBeenCalledWith(APP_ID, false);
    expect(appVersionSources).toHaveBeenCalledWith('o1', APP_ID);
    const saved = vi.mocked(saveExport).mock.calls[0]![0];
    expect(saved.filename).toBe('my-app.bundle');
    expect(saved.bytes!.subarray(0, 16).toString()).toBe('# v2 git bundle\n');
    expect(out).toMatchObject({
      format: 'git',
      file_id: 'f1',
      commits: 2,
      branch: 'main',
      has_data: false,
      hint: expect.stringMatching(/GET \/api\/v1\/files\/f1\/download.*git clone my-app\.bundle/),
    });
  });

  it('refuses an app with no version, and names what to do', async () => {
    vi.mocked(appVersionSources).mockReturnValue(versions([]));
    expect(errorOf(await exp.handler({ id: APP_ID, format: 'git' }, ctx))).toMatch(
      /no version yet.*app_publish/,
    );
    expect(saveExport).not.toHaveBeenCalled();
  });

  it('passes a refused read through and reads nothing', async () => {
    vi.mocked(assertMayCopyApp).mockRejectedValue(new Error('no read'));
    expect(errorOf(await exp.handler({ id: APP_ID, format: 'git' }, ctx))).toMatch(/no read/);
    expect(appVersionSources).not.toHaveBeenCalled();
  });

  it('teaches an unknown format', async () => {
    expect(errorOf(await exp.handler({ id: APP_ID, format: 'zip' }, ctx))).toMatch(/format must be/);
  });

  it('names authors by role and login id, never more', () => {
    expect(versionAuthor({ actor: 'owner', actorLoginId: null })).toBe('owner');
    expect(versionAuthor({ actor: 'member', actorLoginId: 'l1' })).toBe('member l1');
    expect(versionMessage({ seq: 4, note: ' fix ', restoredFrom: null })).toBe('v4 publish: fix');
    expect(versionMessage({ seq: 5, note: null, restoredFrom: 2 })).toBe(
      'v5 publish\n\nRestored from v2.',
    );
  });
});
