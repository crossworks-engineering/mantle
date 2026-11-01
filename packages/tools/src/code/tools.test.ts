/**
 * The code tools over a stubbed store: what reaches the one draft write
 * (changeDraftSource), what a refusal inside it says, the stale `base_rev`,
 * undo, the build pass-through, the search cap, and gate parity with the
 * app tools they stand beside (the reads ask what app_get asks, the writes
 * what app_file_write asks).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    getApp: vi.fn(),
    changeDraftSource: vi.fn(),
    undoCodeEdit: vi.fn(),
  };
});
vi.mock('../app-build-stage', () => ({ buildAndStageApp: vi.fn() }));

import {
  AppDraftRevError,
  AppUndoEmptyError,
  AppUndoStaleError,
  changeDraftSource,
  getApp,
  sourceRev,
  undoCodeEdit,
} from '@mantle/content';
import { APP_LIBRARIES_LEFT_OUT, APP_LIBRARY_SPECIFIERS } from '@mantle/app-build';
import { buildAndStageApp } from '../app-build-stage';
import { APP_TOOLS } from '../builtins-apps';
import { idArgTargets } from '../item-args';
import { OWNER_ONLY_ERROR } from '../surface';
import type { BuiltinToolDef, ToolHandlerContext } from '../types';
import { CODE_TOOLS } from './tools';

const tool = (slug: string) => CODE_TOOLS.find((t) => t.slug === slug)!;
const appTool = (slug: string) => APP_TOOLS.find((t) => t.slug === slug)!;

const ctx: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'web' } };
const APP_ID = '11111111-2222-4333-8444-555555555555';
const TARGET = `app:${APP_ID}`;

const APP_TSX = [
  'export default function App() {',
  '  const label = "Hi";',
  '  return <p>{label} {label}</p>;',
  '}',
  '',
].join('\n');
const TREE = {
  entry: 'App.tsx',
  files: { 'App.tsx': APP_TSX, 'lib/fmt.ts': 'export const x = 1;\n' },
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
  vi.mocked(getApp).mockResolvedValue({ source: TREE, draft: null } as never);
  // The one draft write: the change runs over the tree; a throw is the call's.
  vi.mocked(changeDraftSource).mockImplementation(async (_o, _id, change, opts) => {
    const after = change(TREE);
    const rev = sourceRev(after);
    return {
      before: TREE,
      after,
      beforeRev: sourceRev(TREE),
      rev,
      written: !opts.dryRun && rev !== sourceRev(TREE),
      editId: !opts.dryRun && rev !== sourceRev(TREE) ? 'e1' : null,
    };
  });
});

describe('the target', () => {
  it('takes app:<id> and a bare app id, and teaches any other', async () => {
    expect(outputOf(await tool('code_view').handler({ target: TARGET }, ctx))).toMatchObject({
      target: TARGET,
      entry: 'App.tsx',
      rev: sourceRev(TREE),
    });
    expect(outputOf(await tool('code_view').handler({ target: APP_ID }, ctx)).target).toBe(TARGET);
    expect(errorOf(await tool('code_view').handler({ target: 'sandbox:web' }, ctx))).toMatch(
      /names no source tree: write app:<id>/,
    );
  });

  it('a missing app is not found, with the lookup', async () => {
    vi.mocked(getApp).mockResolvedValue(null);
    expect(errorOf(await tool('code_view').handler({ target: TARGET }, ctx))).toMatch(
      /app 11111111.* not found.*app_list/,
    );
  });
});

describe('code_view', () => {
  it('lists the tree with sizes and line counts', async () => {
    const out = outputOf(await tool('code_view').handler({ target: TARGET }, ctx));
    expect(out.files).toEqual([
      { path: 'App.tsx', bytes: Buffer.byteLength(APP_TSX), lines: 4 },
      { path: 'lib/fmt.ts', bytes: 20, lines: 1 },
    ]);
  });

  it('with no path, says what the app can use, read live from the build allowlist', async () => {
    const out = outputOf(await tool('code_view').handler({ target: TARGET }, ctx));
    const kit = out.kit as {
      language: string;
      entry: string;
      imports: { specifier: string }[];
      refused: string[];
    };
    expect(kit.language).toMatch(/TSX/);
    expect(kit.entry).toBe('App.tsx must export default function App()');
    const specs = kit.imports.map((i) => i.specifier);
    expect(specs).toEqual(
      expect.arrayContaining([
        'react',
        '@host',
        '@/components/ui/button',
        ...APP_LIBRARY_SPECIFIERS,
      ]),
    );
    expect(kit.refused).toEqual(Object.keys(APP_LIBRARIES_LEFT_OUT));
  });

  it('shows numbered lines of a range', async () => {
    const out = outputOf(
      await tool('code_view').handler({ target: TARGET, path: './App.tsx', start: 2, end: 2 }, ctx),
    );
    expect(out).toMatchObject({
      path: 'App.tsx',
      text: '2\t  const label = "Hi";',
      total_lines: 4,
    });
  });

  it('a missing file names a near one and the files', async () => {
    const err = errorOf(await tool('code_view').handler({ target: TARGET, path: 'app.tsx' }, ctx));
    expect(err).toMatch(/no file 'app.tsx'.*did you mean 'App.tsx'\?.*App.tsx, lib\/fmt.ts/);
  });
});

describe('code_search', () => {
  it('caps the hits and says so', async () => {
    const out = outputOf(
      await tool('code_search').handler({ target: TARGET, pattern: 'label', max_results: 1 }, ctx),
    );
    expect(out).toMatchObject({
      total: 2,
      truncated: true,
      hits: ['App.tsx:2:   const label = "Hi";'],
    });
    expect(out.hint).toMatch(/Showing 1 of 2 hits/);
  });

  it('a glob of many stars answers at once', async () => {
    const started = Date.now();
    const out = outputOf(
      await tool('code_search').handler(
        { target: TARGET, pattern: 'label', glob: '*'.repeat(150) + 'x' },
        ctx,
      ),
    );
    // App.tsx ends in x: the glob holds, and it answered at once.
    expect(out).toMatchObject({ total: 2 });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a glob that matches no file teaches', async () => {
    expect(
      errorOf(
        await tool('code_search').handler({ target: TARGET, pattern: 'x', glob: '*.css' }, ctx),
      ),
    ).toMatch(/glob '\*\.css' matches no file/);
  });
});

describe('code_edit', () => {
  const edit = (input: Record<string, unknown>) =>
    tool('code_edit').handler({ target: TARGET, path: 'App.tsx', ...input }, ctx);

  it('replaces text found once and returns a diff and the new rev', async () => {
    const out = outputOf(await edit({ edits: [{ old: '"Hi"', new: '"Hello"' }] }));
    expect(out).toMatchObject({ written: true, replaced: 1, base_rev: sourceRev(TREE) });
    expect(out.diff).toContain('-  const label = "Hi";\n+  const label = "Hello";');
    expect(changeDraftSource).toHaveBeenCalledWith(
      'o1',
      APP_ID,
      expect.any(Function),
      expect.objectContaining({ actor: 'agent', note: 'code_edit App.tsx', baseRev: null }),
    );
  });

  it('two matches fail, say where, and nothing is written', async () => {
    const err = errorOf(await edit({ edits: [{ old: '{label}', new: '{x}' }] }));
    expect(err).toMatch(/matches 2 times \(lines 3, 3\).*Nothing was changed \(App.tsx\)/);
  });

  it('all or nothing: a failing second edit leaves the first unapplied', async () => {
    const err = errorOf(
      await edit({
        edits: [
          { old: '"Hi"', new: '"Hello"' },
          { old: 'missing', new: 'x' },
        ],
      }),
    );
    expect(err).toMatch(/^edit 2 of 2: old was not found/);
  });

  it('dry_run asks for no write and skips the build', async () => {
    const out = outputOf(
      await edit({ edits: [{ old: '"Hi"', new: '"Yo"' }], dry_run: true, build: true }),
    );
    expect(vi.mocked(changeDraftSource).mock.calls[0]![3]).toMatchObject({ dryRun: true });
    expect(out).toMatchObject({ dry_run: true, written: false, build: 'skipped' });
    expect(out.diff).toContain('+  const label = "Yo";');
    expect(buildAndStageApp).not.toHaveBeenCalled();
  });

  it('a stale base_rev fails with the current rev', async () => {
    vi.mocked(changeDraftSource).mockRejectedValue(new AppDraftRevError('old-rev', 'new-rev'));
    const err = errorOf(await edit({ edits: [{ old: '"Hi"', new: '"Yo"' }], base_rev: 'old-rev' }));
    expect(vi.mocked(changeDraftSource).mock.calls[0]![3]).toMatchObject({ baseRev: 'old-rev' });
    expect(err).toMatch(
      /changed since rev old-rev: it is rev new-rev now.*code_view.*base_rev new-rev/,
    );
  });

  it('build: true builds after the write and returns the errors with their places', async () => {
    vi.mocked(buildAndStageApp).mockResolvedValue({
      buildOk: false,
      errors: [{ text: 'Expected ";"', location: { file: 'App.tsx', line: 2, column: 9 } }],
      warnings: [],
      bytes: 0,
    } as never);
    const out = outputOf(await edit({ edits: [{ old: '"Hi"', new: '"Hi' }], build: true }));
    expect(buildAndStageApp).toHaveBeenCalledWith('o1', APP_ID);
    expect(out.written).toBe(true);
    expect(out.build).toMatchObject({
      ok: false,
      errors: [{ file: 'App.tsx', line: 2, column: 9, text: 'Expected ";"' }],
      more: 0,
    });
  });

  it('a green build reports its size', async () => {
    vi.mocked(buildAndStageApp).mockResolvedValue({
      buildOk: true,
      errors: [],
      warnings: [],
      bytes: 1234,
    } as never);
    const out = outputOf(await edit({ edits: [{ old: '"Hi"', new: '"Yo"' }], build: true }));
    expect(out.build).toEqual({ ok: true, bytes: 1234, warnings: 0 });
  });

  it('more edits than the cap are refused before any write (a run item is not schema-checked)', async () => {
    const edits = Array.from({ length: 51 }, () => ({ old: 'a', new: 'b' }));
    expect(errorOf(await edit({ edits }))).toMatch(/edits holds 51; send at most 50/);
    expect(changeDraftSource).not.toHaveBeenCalled();
  });

  it('a file not in the tree points at code_write', async () => {
    expect(
      errorOf(
        await tool('code_edit').handler(
          { target: TARGET, path: 'nope.ts', edits: [{ old: 'a', new: 'b' }] },
          ctx,
        ),
      ),
    ).toMatch(/no file 'nope.ts'.*code_write/);
  });
});

describe('a key stored before the one path rule', () => {
  const OLD = { entry: 'App.tsx', files: { 'App.tsx': 'a\n', './x.ts': 'old\n' } };
  beforeEach(() => {
    vi.mocked(getApp).mockResolvedValue({ source: OLD, draft: null } as never);
    vi.mocked(changeDraftSource).mockImplementation(async (_o, _id, change) => {
      const after = change(OLD);
      return { before: OLD, after, beforeRev: 'r0', rev: 'r1', written: true, editId: 'e1' };
    });
  });

  it('is reached by its exact name, and edited in place (no second file)', async () => {
    const view = outputOf(await tool('code_view').handler({ target: TARGET, path: './x.ts' }, ctx));
    expect(view).toMatchObject({ path: './x.ts', text: '1\told' });
    const out = outputOf(
      await tool('code_edit').handler(
        { target: TARGET, path: './x.ts', edits: [{ old: 'old', new: 'new' }] },
        ctx,
      ),
    );
    expect(out.path).toBe('./x.ts');
    const change = vi.mocked(changeDraftSource).mock.calls[0]![2];
    expect(Object.keys(change(OLD).files).sort()).toEqual(['./x.ts', 'App.tsx']);
    expect(change(OLD).files['./x.ts']).toBe('new\n');
  });

  it('app_file_write refuses a new path outside the app', async () => {
    const err = errorOf(
      await appTool('app_file_write').handler(
        { id: APP_ID, path: 'a/../../x.ts', content: 'y' },
        ctx,
      ),
    );
    expect(err).toMatch(/must be relative inside the app/);
  });

  it('app_file_write writes the exact key too', async () => {
    await appTool('app_file_write').handler({ id: APP_ID, path: './x.ts', content: 'y' }, ctx);
    const change = vi.mocked(changeDraftSource).mock.calls[0]![2];
    expect(change(OLD).files).toEqual({ 'App.tsx': 'a\n', './x.ts': 'y' });
  });
});

describe('CRLF files', () => {
  const CRLF = { entry: 'App.tsx', files: { 'App.tsx': 'a\r\nb\r\n' } };
  beforeEach(() => {
    vi.mocked(getApp).mockResolvedValue({ source: CRLF, draft: null } as never);
    vi.mocked(changeDraftSource).mockImplementation(async (_o, _id, change) => {
      const after = change(CRLF);
      return { before: CRLF, after, beforeRev: 'r0', rev: 'r1', written: true, editId: 'e1' };
    });
  });

  it('view shows LF; an edit copied from it matches and keeps CRLF', async () => {
    const view = outputOf(
      await tool('code_view').handler({ target: TARGET, path: 'App.tsx' }, ctx),
    );
    expect(view.text).toBe('1\ta\n2\tb');
    await tool('code_edit').handler(
      { target: TARGET, path: 'App.tsx', edits: [{ old: 'a\nb', new: 'a\nx' }] },
      ctx,
    );
    const change = vi.mocked(changeDraftSource).mock.calls[0]![2];
    expect(change(CRLF).files['App.tsx']).toBe('a\r\nx\r\n');
  });

  it('a file with mixed line ends shows as stored', async () => {
    const MIXED = { entry: 'App.tsx', files: { 'App.tsx': 'a\r\nb\nc' } };
    vi.mocked(getApp).mockResolvedValue({ source: MIXED, draft: null } as never);
    const view = outputOf(
      await tool('code_view').handler({ target: TARGET, path: 'App.tsx' }, ctx),
    );
    expect(view.text).toBe('1\ta\r\n2\tb\n3\tc');
  });

  it('an insert keeps CRLF', async () => {
    await tool('code_insert').handler(
      { target: TARGET, path: 'App.tsx', after_line: 1, text: 'n' },
      ctx,
    );
    const change = vi.mocked(changeDraftSource).mock.calls[0]![2];
    expect(change(CRLF).files['App.tsx']).toBe('a\r\nn\r\nb\r\n');
  });
});

describe('code_insert and code_write', () => {
  it('inserts after a line', async () => {
    const out = outputOf(
      await tool('code_insert').handler(
        { target: TARGET, path: 'lib/fmt.ts', after_line: 0, text: '// fmt' },
        ctx,
      ),
    );
    expect(out.diff).toContain('+// fmt');
  });

  it('a line past the end teaches the last line', async () => {
    expect(
      errorOf(
        await tool('code_insert').handler(
          { target: TARGET, path: 'lib/fmt.ts', after_line: 9, text: 'x' },
          ctx,
        ),
      ),
    ).toMatch(/has 1 line\(s\)\. Use 1/);
  });

  it('creates a file, and refuses a path that leaves the app', async () => {
    const out = outputOf(
      await tool('code_write').handler(
        { target: TARGET, path: 'lib/new.ts', content: 'a\nb\n' },
        ctx,
      ),
    );
    expect(out).toMatchObject({ created: true, lines: 2, written: true });
    expect(
      errorOf(
        await tool('code_write').handler({ target: TARGET, path: '../x.ts', content: '' }, ctx),
      ),
    ).toMatch(/no '\.\.'/);
    // The bad path is refused inside the change, before anything is written.
    expect(changeDraftSource).toHaveBeenCalledTimes(2);
  });
});

describe('code_undo', () => {
  const EDIT = '22222222-3333-4444-8555-666666666666';
  const undone = (after: Record<string, string>, files: string[]) => ({
    before: TREE,
    after: { entry: 'App.tsx', files: after },
    beforeRev: sourceRev(TREE),
    rev: 'r2',
    written: true,
    editId: 'e9',
    undid: EDIT,
    files,
    teamRules: false,
  });

  it('takes back a write by edit_id: each file it changed, with a diff', async () => {
    vi.mocked(undoCodeEdit).mockResolvedValue(
      undone({ 'App.tsx': 'old\n' }, ['App.tsx', 'lib/fmt.ts']),
    );
    const out = outputOf(
      await tool('code_undo').handler({ target: TARGET, edit_id: EDIT, base_rev: 'r9' }, ctx),
    );
    expect(undoCodeEdit).toHaveBeenCalledWith(
      'o1',
      APP_ID,
      expect.objectContaining({ actor: 'agent', editId: EDIT, path: null, baseRev: 'r9' }),
    );
    expect(out).toMatchObject({ undid: EDIT, edit_id: 'e9', rev: 'r2' });
    expect(out.files).toEqual([
      { path: 'App.tsx', diff: expect.stringContaining('+old') },
      { path: 'lib/fmt.ts', removed: true },
    ]);
  });

  it('with only a path, undoes its newest write (an old-style key by its exact name)', async () => {
    const OLD = { entry: 'App.tsx', files: { 'App.tsx': 'a\n', './x.ts': 'x\n' } };
    vi.mocked(getApp).mockResolvedValue({ source: OLD, draft: null } as never);
    vi.mocked(undoCodeEdit).mockResolvedValue(undone({ 'App.tsx': 'a\n' }, ['./x.ts']));
    await tool('code_undo').handler({ target: TARGET, path: './x.ts' }, ctx);
    expect(vi.mocked(undoCodeEdit).mock.calls[0]![2]).toMatchObject({
      editId: null,
      path: './x.ts',
    });
  });

  it('needs an edit_id or a path, and a real edit_id', async () => {
    expect(errorOf(await tool('code_undo').handler({ target: TARGET }, ctx))).toMatch(
      /give the edit_id/,
    );
    expect(
      errorOf(await tool('code_undo').handler({ target: TARGET, edit_id: 'nope' }, ctx)),
    ).toMatch(/is not one: copy it from the write/);
    expect(undoCodeEdit).not.toHaveBeenCalled();
  });

  it('later work on the file refuses the undo and says what to use', async () => {
    vi.mocked(undoCodeEdit).mockRejectedValue(new AppUndoStaleError('App.tsx'));
    expect(
      errorOf(await tool('code_undo').handler({ target: TARGET, edit_id: EDIT }, ctx)),
    ).toMatch(/'App.tsx' changed after that write.*code_edit or code_write/);
  });

  it('nothing to undo says what to use instead', async () => {
    vi.mocked(undoCodeEdit).mockRejectedValue(new AppUndoEmptyError({ path: 'App.tsx' }));
    expect(
      errorOf(await tool('code_undo').handler({ target: TARGET, path: 'App.tsx' }, ctx)),
    ).toMatch(/no kept write changed 'App.tsx'.*app_snapshot_restore/);
  });

  it('every write returns its edit_id', async () => {
    const out = outputOf(
      await tool('code_write').handler({ target: TARGET, path: 'lib/n.ts', content: 'n\n' }, ctx),
    );
    expect(out.edit_id).toBe('e1');
  });
});

describe('gate parity with the app tools', () => {
  const WRITES = ['code_edit', 'code_insert', 'code_write', 'code_undo'];
  const READS = ['code_view', 'code_search'];

  it('the writes ask what app_file_write asks, of the target', () => {
    const ref = appTool('app_file_write');
    for (const slug of WRITES) {
      const t = tool(slug);
      const {
        matrix,
        itemArgs,
        clientSourced,
        idempotent: _i,
        ...rest
      } = t.policy as Record<string, unknown>;
      const {
        matrix: refMatrix,
        itemArgs: _ri,
        clientSourced: _rc,
        ...refRest
      } = ref.policy as Record<string, unknown>;
      expect(rest, slug).toEqual(refRest);
      expect(matrix, slug).toEqual({ ...(refMatrix as object), param: 'target' });
      expect(itemArgs, slug).toEqual([{ param: 'target', by: 'code-target' }]);
      expect(clientSourced, slug).toEqual({ kind: 'write', appTargets: ['target'] });
      expect([t.ownerOnly, t.loginTurns], slug).toEqual([ref.ownerOnly, ref.loginTurns]);
      expect(t.policy.outside?.appCode, slug).toBe(true);
    }
  });

  it('the reads ask what app_get asks', () => {
    const { matrix: refMatrix, ...refRest } = appTool('app_get').policy as Record<string, unknown>;
    for (const slug of READS) {
      const { matrix, ...rest } = tool(slug).policy as Record<string, unknown>;
      expect(rest, slug).toEqual(refRest);
      expect(matrix, slug).toEqual({ ...(refMatrix as object), param: 'target' });
      expect(tool(slug).ownerOnly, slug).toBe(appTool('app_get').ownerOnly);
    }
  });

  it('a write is refused off an owner surface, as app_file_write is', async () => {
    const team: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'team' } as never };
    for (const slug of WRITES) {
      const res = await tool(slug).handler(
        {
          target: TARGET,
          path: 'App.tsx',
          content: 'x',
          edits: [{ old: 'a', new: 'b' }],
          after_line: 0,
          text: 'x',
        },
        team,
      );
      expect(errorOf(res), slug).toBe(OWNER_ONLY_ERROR);
    }
    expect(
      errorOf(
        await appTool('app_file_write').handler({ id: APP_ID, path: 'a', content: 'x' }, team),
      ),
    ).toBe(OWNER_ONLY_ERROR);
    expect(changeDraftSource).not.toHaveBeenCalled();
    expect(undoCodeEdit).not.toHaveBeenCalled();
  });

  it("the audit and the queue read the target's app as the item", () => {
    const args = tool('code_edit').policy.itemArgs!;
    expect(idArgTargets(args, { target: TARGET.toUpperCase() })).toEqual([APP_ID]);
    expect(idArgTargets(args, { target: APP_ID })).toEqual([APP_ID]);
    expect(idArgTargets(args, { target: 'sandbox:web' })).toEqual([]);
    expect(idArgTargets(appTool('app_file_write').policy.itemArgs!, { id: APP_ID })).toEqual([
      APP_ID,
    ]);
  });
});
