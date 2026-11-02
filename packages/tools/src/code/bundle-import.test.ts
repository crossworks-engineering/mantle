/**
 * app_source_from_bundle over a stubbed store, with the real bundle on both
 * sides: app_export's git mode writes it, real git clones it, commits and
 * bundles it back, and the import writes the newest commit into the draft
 * only when that history holds the live version's commit. The rights are
 * the DB lanes' (A8 tool cells); the reader's limits are
 * git-bundle-read.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return { ...actual, getApp: vi.fn(), changeDraftSource: vi.fn() };
});
vi.mock('@mantle/content/app-snapshots', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/app-snapshots')>();
  return { ...actual, appVersionSources: vi.fn(), appVersionTotals: vi.fn() };
});
vi.mock('@mantle/content/app-package', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/app-package')>();
  return { ...actual, assertMayCopyApp: vi.fn() };
});
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  return { ...actual, assertItemRight: vi.fn() };
});
vi.mock('../app-build-stage', () => ({ buildAndStageApp: vi.fn() }));
vi.mock('@mantle/files', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/files')>();
  return {
    ...actual,
    saveExport: vi.fn(),
    openFileById: vi.fn(),
    spoolUpload: vi.fn(async (stream: AsyncIterable<Buffer>) => {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c);
      return { bytes: Buffer.concat(chunks) };
    }),
  };
});

import { changeDraftSource, getApp, sourceRev } from '@mantle/content';
import {
  appVersionSources,
  appVersionTotals,
  type AppVersionSource,
} from '@mantle/content/app-snapshots';
import { assertItemRight } from '@mantle/db';
import { openFileById, saveExport } from '@mantle/files';
import { buildAndStageApp } from '../app-build-stage';
import { APP_TOOLS } from '../builtins-apps';
import type { BuiltinToolDef, ToolHandlerContext } from '../types';

const dir = mkdtempSync(path.join(tmpdir(), 'bundle-import-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(dir, 'no-gitconfig'),
      GIT_AUTHOR_NAME: 'agent',
      GIT_AUTHOR_EMAIL: 'agent@example.invalid',
      GIT_COMMITTER_NAME: 'agent',
      GIT_COMMITTER_EMAIL: 'agent@example.invalid',
    },
  });

const tool = (slug: string) => APP_TOOLS.find((t) => t.slug === slug)!;
const exp = tool('app_export');
const imp = tool('app_source_from_bundle');
const ctx: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'web' } };
const APP_ID = '11111111-2222-4333-8444-555555555555';
const FILE_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;
const errorOf = (r: Result) => {
  if (r.ok) throw new Error(`expected a failure, got ${JSON.stringify(r.output)}`);
  return r.error;
};
const outputOf = (r: Result) => {
  if (!r.ok) throw new Error(`expected success, got: ${r.error}`);
  return r.output as Record<string, unknown>;
};

const V1 = { entry: 'App.tsx', files: { 'App.tsx': 'export default () => 1;\n' } };
const V2 = {
  entry: 'App.tsx',
  files: { 'App.tsx': 'export default () => 2;\n', 'lib/fmt.ts': 'export const f = 1;\n' },
};
const version = (seq: number, source: typeof V1): AppVersionSource => ({
  seq,
  note: seq === 2 ? 'second' : null,
  actor: 'owner',
  actorLoginId: null,
  createdAt: new Date(Date.UTC(2026, 9, seq)),
  restoredFrom: null,
  source,
});
async function* versions() {
  yield version(1, V1);
  yield version(2, V2);
}

/** The draft write: run the tool's change on `draft`, return what a write
 *  returns. */
let written: { entry: string; files: Record<string, string> } | null = null;
let liveRev: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  written = null;
  vi.mocked(getApp).mockResolvedValue({ title: 'My App', source: V2, draft: null } as never);
  vi.mocked(appVersionTotals).mockResolvedValue({ versions: 2, sourceBytes: 100 });
  vi.mocked(appVersionSources).mockImplementation(() => versions());
  vi.mocked(saveExport).mockResolvedValue({
    file: { id: FILE_ID, filename: 'my-app.bundle', parentPath: 'files', sizeBytes: 10 },
    landedIn: null,
  } as never);
  vi.mocked(buildAndStageApp).mockResolvedValue({ buildOk: true, errors: [] } as never);
  vi.mocked(changeDraftSource).mockImplementation(async (_o, _id, change, opts) => {
    liveRev = opts.liveRev;
    const after = change(V2);
    written = after;
    return { before: V2, after, beforeRev: 'r0', rev: 'r1', written: true, editId: 'e1' } as never;
  });
});

/** The export's bundle, cloned; a commit on it; the bundle of that. */
async function roundTrip(edit: (repo: string) => void, ...bundleArgs: string[]): Promise<Buffer> {
  const out = outputOf(await exp.handler({ id: APP_ID, format: 'git' }, ctx));
  expect(out.format).toBe('git');
  const bytes = (vi.mocked(saveExport).mock.calls[0]![0].spooled as unknown as { bytes: Buffer })
    .bytes;
  const tag = Math.random().toString(36).slice(2, 8);
  const exported = path.join(dir, `${tag}.bundle`);
  writeFileSync(exported, bytes);
  const repo = path.join(dir, tag);
  git(dir, 'clone', '-q', exported, repo);
  edit(repo);
  const back = path.join(dir, `${tag}-back.bundle`);
  git(repo, 'bundle', 'create', '-q', back, ...(bundleArgs.length ? bundleArgs : ['main']));
  return readFileSync(back);
}

const serve = (buf: Buffer) =>
  vi.mocked(openFileById).mockResolvedValue({
    row: {} as never,
    stream: Readable.from([buf]),
    size: buf.length,
  });

describe('app_source_from_bundle', () => {
  it('writes the newest commit into the draft, with the live tree as its base, then builds', async () => {
    const buf = await roundTrip((repo) => {
      writeFileSync(path.join(repo, 'App.tsx'), 'export default () => 3;\n');
      git(repo, 'commit', '-qam', 'three');
    });
    serve(buf);
    const out = outputOf(await imp.handler({ id: APP_ID, file_id: FILE_ID }, ctx));
    expect(assertItemRight).toHaveBeenCalledWith(FILE_ID, 'read');
    expect(written).toEqual({
      entry: 'App.tsx',
      files: { 'App.tsx': 'export default () => 3;\n', 'lib/fmt.ts': 'export const f = 1;\n' },
    });
    expect(liveRev).toBe(sourceRev(V2));
    expect(out).toMatchObject({
      ref: 'refs/heads/main',
      edit_id: 'e1',
      build_ok: true,
      file_count: 2,
    });
    expect(buildAndStageApp).toHaveBeenCalledWith('o1', APP_ID);
  });

  it('refuses a history without the live version: nothing is written', async () => {
    // A commit on v1 only: the live v2 is not in its history.
    const buf = await roundTrip((repo) => {
      git(repo, 'checkout', '-q', '-b', 'old', 'HEAD~1');
      writeFileSync(path.join(repo, 'App.tsx'), 'export default () => 9;\n');
      git(repo, 'commit', '-qam', 'from v1');
    }, 'old');
    serve(buf);
    expect(errorOf(await imp.handler({ id: APP_ID, file_id: FILE_ID }, ctx))).toMatch(
      /does not hold the app's live version .* Nothing changed/,
    );
    expect(changeDraftSource).not.toHaveBeenCalled();
  });

  it('refuses when the live code is not the newest version', async () => {
    serve(await roundTrip(() => {}));
    vi.mocked(getApp).mockResolvedValue({ title: 'A', source: V1, draft: null } as never);
    expect(errorOf(await imp.handler({ id: APP_ID, file_id: FILE_ID }, ctx))).toMatch(
      /live code is not its newest version/,
    );
    expect(changeDraftSource).not.toHaveBeenCalled();
  });

  it('refuses an entry the bundle lacks, and a file that is no bundle', async () => {
    serve(await roundTrip(() => {}));
    expect(
      errorOf(await imp.handler({ id: APP_ID, file_id: FILE_ID, entry: 'Main.tsx' }, ctx)),
    ).toMatch(/no entry file 'Main.tsx'.*Nothing changed/);
    serve(Buffer.from('PK\x03\x04 not a bundle'));
    expect(errorOf(await imp.handler({ id: APP_ID, file_id: FILE_ID }, ctx))).toMatch(
      /is not a git bundle/,
    );
  });

  it('refuses a file past the size before it reads it', async () => {
    const stream = Readable.from([Buffer.alloc(1)]);
    vi.mocked(openFileById).mockResolvedValue({ row: {} as never, stream, size: 65 * 1024 * 1024 });
    expect(errorOf(await imp.handler({ id: APP_ID, file_id: FILE_ID }, ctx))).toMatch(
      /past the 64 MB a bundle may be/,
    );
    expect(stream.destroyed).toBe(true);
  });

  it('keeps a live file the export left out (a name git may not hold), and says so', async () => {
    const V3 = { entry: 'App.tsx', files: { ...V2.files, 'a:b.ts': 'export const ab = 1;\n' } };
    vi.mocked(appVersionSources).mockImplementation(async function* () {
      yield version(1, V1);
      yield version(2, V3);
    });
    vi.mocked(getApp).mockResolvedValue({ title: 'A', source: V3, draft: null } as never);
    const buf = await roundTrip((repo) => {
      writeFileSync(path.join(repo, 'App.tsx'), 'export default () => 4;\n');
      git(repo, 'commit', '-qam', 'four');
    });
    serve(buf);
    const out = outputOf(await imp.handler({ id: APP_ID, file_id: FILE_ID }, ctx));
    expect(out.kept_from_live).toEqual(['a:b.ts']);
    expect(written!.files).toEqual({ ...V3.files, 'App.tsx': 'export default () => 4;\n' });
  });

  it('refuses an app with no version', async () => {
    vi.mocked(appVersionTotals).mockResolvedValue({ versions: 0, sourceBytes: 0 });
    expect(errorOf(await imp.handler({ id: APP_ID, file_id: FILE_ID }, ctx))).toMatch(
      /has no version yet/,
    );
    expect(openFileById).not.toHaveBeenCalled();
  });
});
