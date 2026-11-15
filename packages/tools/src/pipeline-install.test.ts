/**
 * Add, read and remove an own pipeline (docs/pipelines.md, "Own
 * pipelines"), with no Postgres: the table is a stand-in that keeps the
 * rows an install wrote; the folder writer, the registry, the package check
 * and the version rule are the real ones, on a made-up mount folder. The
 * routes, the Admin check and the real table are proven on Postgres
 * (server/web/app/api/pipelines/pipelines-install-route.db.test.ts).
 *
 *  - An install writes the folder (a file 0644, under bin/ 0755), then the
 *    row, and starts no job (no parser call).
 *  - A version names one package: the same files again write the folder
 *    again and nothing else; other files at the same version, or a lower
 *    version, are refused; a higher one replaces, and the folders older
 *    than the version before go (a job of the version before finds its
 *    folder). Two installs of one id at once run one after the other.
 *  - Refused before any write: a curated box, no mount, a broken package, a
 *    built-in's id, an extension another reader reads.
 *  - A write that fails leaves no half folder and no row.
 *  - pipeline_get gives an own package; a built-in is refused with where its
 *    code is.
 *  - pipeline_remove takes the row, then the folders; a remove again (a
 *    half-done remove: a folder with no row) removes the folder and answers
 *    as done; a built-in is refused.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelinePackage } from '@mantle/files';
import type { ToolHandlerContext } from './types';

const h = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  puts: 0,
  lock: Promise.resolve() as Promise<unknown>,
}));

vi.mock('@mantle/content/pipeline-state', async (orig) => {
  const actual = await orig<typeof import('@mantle/content/pipeline-state')>();
  const f = await import('@mantle/files');
  return {
    ...actual,
    ownManifests: async () =>
      [...h.rows].map(([id, pkg]) => {
        const text = (pkg as PipelinePackage).files['pipeline.json'];
        return { id, manifest: typeof text === 'string' ? text : null };
      }),
    ownPackageOf: async (_owner: string, id: string) => (h.rows.get(id) as PipelinePackage) ?? null,
    putOwnPackage: async (_owner: string, _login: string | null, id: string, pkg: unknown) => {
      h.puts += 1;
      h.rows.set(id, pkg);
    },
    removeOwnRow: async (_owner: string, id: string) => {
      h.rows.delete(id);
    },
    // One install at a time, as the lock gives on Postgres.
    underPackageLock: async <T>(_owner: string, _id: string, fn: (tx: never) => Promise<T>) => {
      const run = h.lock.then(() => fn(undefined as never));
      h.lock = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    pipelineStateOf: async (_owner: string, m: import('@mantle/files').PipelineManifest) => {
      const options = f.effectiveOptions(m, {});
      return { offIn: [], options, optionsHash: '', runs: 0, lastRunAt: null };
    },
  };
});

const { PIPELINE_INSTALL_TOOLS, INSTALL_NOTE } = await import('./pipeline-install');
const { packageOnDisk } = await import('@mantle/content/pipeline-folder');
const tool = (slug: string) => PIPELINE_INSTALL_TOOLS.find((t) => t.slug === slug)!;

const OWNER = '00000000-0000-4000-8000-000000000001';
const ctx = {
  ownerId: OWNER,
  surface: { kind: 'web', loginId: OWNER },
} as unknown as ToolHandlerContext;

const TEMPLATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/pipeline-template/bun',
);
const root = mkdtempSync(path.join(os.tmpdir(), 'pipeline-install-test-'));
const mount = path.join(root, 'pipelines');
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The Bun template as an install sends it, at `version`, with more files. */
function template(version = '1.0.0', more: Record<string, unknown> = {}) {
  const files: Record<string, unknown> = {};
  for (const name of readdirSync(TEMPLATE)) {
    files[name] = readFileSync(path.join(TEMPLATE, name), 'utf8');
  }
  const manifest = JSON.parse(files['pipeline.json'] as string) as Record<string, unknown>;
  files['pipeline.json'] = JSON.stringify({ ...manifest, version });
  return { files: { ...files, ...more } };
}

const fetchSpy = vi.fn();
beforeEach(() => {
  h.rows.clear();
  h.puts = 0;
  rmSync(mount, { recursive: true, force: true });
  mkdirSync(mount, { recursive: true });
  vi.stubEnv('MANTLE_PIPELINES_DIR', mount);
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const install = (pkg: unknown) => tool('pipeline_install').handler(pkg as never, ctx);
const errorOf = async (pkg: unknown) => {
  const res = await install(pkg);
  return res.ok ? null : res.error;
};

describe('pipeline_install', () => {
  it('writes the folder, then the row, and starts no job', async () => {
    const res = await install(template('1.0.0', { 'bin/decode': { base64: 'AAEC' } }));
    expect(res.ok).toBe(true);
    const out = (
      res as { output: { row: { id: string; source: string; reads: string[] }; note: string } }
    ).output;
    expect(out.note).toBe(INSTALL_NOTE);
    expect([out.row.id, out.row.source, out.row.reads]).toEqual(['lx9-logger', 'own', ['lx9']]);
    const dir = path.join(mount, 'lx9-logger', '1.0.0');
    expect(statSync(path.join(dir, 'step.ts')).mode & 0o777).toBe(0o644);
    expect(statSync(path.join(dir, 'bin', 'decode')).mode & 0o777).toBe(0o755);
    expect(readFileSync(path.join(dir, 'bin', 'decode'))).toEqual(Buffer.from([0, 1, 2]));
    expect(h.rows.has('lx9-logger')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    // No temporary folder is left.
    expect(readdirSync(mount).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it('a version names one package: the same files rewrite the folder only; other files or a lower version are refused; a higher replaces', async () => {
    await install(template('1.2.0'));
    rmSync(path.join(mount, 'lx9-logger'), { recursive: true });
    const again = await install(template('1.2.0'));
    expect(again.ok).toBe(true);
    expect(existsSync(path.join(mount, 'lx9-logger', '1.2.0', 'pipeline.json'))).toBe(true);
    expect(h.puts).toBe(1);
    expect(await errorOf(template('1.2.0', { 'extra.ts': 'x' }))).toMatch(
      /Version 1.2.0 is installed with other files. Send a higher version./,
    );
    expect(await errorOf(template('1.1.9'))).toBe(
      'Version 1.2.0 is installed. Send a higher version.',
    );
    expect((await install(template('1.10.0'))).ok).toBe(true);
    // The version before stays beside the new one; an older one goes.
    expect(readdirSync(path.join(mount, 'lx9-logger')).sort()).toEqual(['1.10.0', '1.2.0']);
    expect(h.puts).toBe(2);
    expect((await install(template('1.11.0'))).ok).toBe(true);
    expect(readdirSync(path.join(mount, 'lx9-logger')).sort()).toEqual(['1.10.0', '1.11.0']);
  });

  it('a job of the version before still finds its folder after an install', async () => {
    await install(template('1.0.0'));
    // A job sent with 1.0.0 that runs after the install of 1.1.0.
    expect((await install(template('1.1.0'))).ok).toBe(true);
    expect(await packageOnDisk('lx9-logger', '1.0.0')).toBe(true);
    expect(await packageOnDisk('lx9-logger', '1.1.0')).toBe(true);
    // The same version again keeps it too, and leaves no temporary folder.
    expect((await install(template('1.1.0'))).ok).toBe(true);
    expect(await packageOnDisk('lx9-logger', '1.0.0')).toBe(true);
    expect(readdirSync(mount).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
  });

  it("two installs of one id at once: the folder of the version is the row's package", async () => {
    await install(template('1.0.0'));
    const [a, b] = await Promise.all([
      install(template('1.1.0', { 'a.ts': 'a' })),
      install(template('1.1.0', { 'b.ts': 'b' })),
    ]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const row = h.rows.get('lx9-logger') as PipelinePackage;
    const dir = path.join(mount, 'lx9-logger', '1.1.0');
    expect(existsSync(path.join(dir, 'a.ts'))).toBe('a.ts' in row.files);
    expect(existsSync(path.join(dir, 'b.ts'))).toBe('b.ts' in row.files);
  });

  it('refuses before any write: curated, no mount, a broken package, a built-in id, a taken extension', async () => {
    vi.stubEnv('MANTLE_PIPELINES', 'curated');
    expect(await errorOf(template())).toBe('This box runs curated pipelines only.');
    vi.stubEnv('MANTLE_PIPELINES', '');
    vi.stubEnv('MANTLE_PIPELINES_DIR', path.join(root, 'no-such-mount'));
    expect(await errorOf(template())).toMatch(/no pipelines folder/);
    vi.stubEnv('MANTLE_PIPELINES_DIR', mount);
    expect(await errorOf({ files: { 'step.ts': 'x' } })).toMatch(/pipeline\.json/);
    const m = JSON.parse(template().files['pipeline.json'] as string) as Record<string, unknown>;
    expect(
      await errorOf({
        files: { ...template().files, 'pipeline.json': JSON.stringify({ ...m, id: 'sheet' }) },
      }),
    ).toMatch(/The id sheet is a built-in's/);
    expect(
      await errorOf({
        files: {
          ...template().files,
          'pipeline.json': JSON.stringify({ ...m, match: { ext: ['csv'] } }),
        },
      }),
    ).toMatch(/\.csv is read by the pipeline sheet/);
    expect(h.rows.size).toBe(0);
    expect(readdirSync(mount)).toEqual([]);
  });

  it('a write that fails leaves no half folder and no row', async () => {
    // A file and a folder of the same name: the second write fails.
    const res = await install(template('1.0.0', { lib: 'x', 'lib/a.ts': 'y' }));
    expect(res.ok).toBe(false);
    expect(readdirSync(mount)).toEqual([]);
    expect(h.rows.size).toBe(0);
  }, 20_000);
});

describe('pipeline_get', () => {
  it('gives an own package; a built-in is refused with where its code is', async () => {
    await install(template());
    const got = await tool('pipeline_get').handler({ id: 'lx9-logger' }, ctx);
    expect(got.ok && (got.output as { version: string }).version).toBe('1.0.0');
    const builtin = await tool('pipeline_get').handler({ id: 'sheet' }, ctx);
    expect(builtin.ok ? null : builtin.error).toMatch(
      /packages\/files\/src\/pipelines\/pkg\/sheet\//,
    );
  });
});

describe('pipeline_remove', () => {
  it('takes the row, then the folders; a remove again answers as done; a built-in is refused', async () => {
    await install(template());
    const draft = path.join(mount, '.drafts', 'lx9-logger.0123456789abcdef');
    const other = path.join(mount, '.drafts', 'lx9-logger-two.0123456789abcdef');
    mkdirSync(draft, { recursive: true });
    mkdirSync(other, { recursive: true });
    const res = await tool('pipeline_remove').handler({ id: 'lx9-logger' }, ctx);
    expect(res.ok).toBe(true);
    expect(h.rows.has('lx9-logger')).toBe(false);
    expect(existsSync(path.join(mount, 'lx9-logger'))).toBe(false);
    expect(existsSync(draft)).toBe(false);
    // Another id's draft stays.
    expect(existsSync(other)).toBe(true);
    // A half-done remove: a folder with no row. The next remove clears it.
    mkdirSync(path.join(mount, 'lx9-logger', '1.0.0'), { recursive: true });
    const again = await tool('pipeline_remove').handler({ id: 'lx9-logger' }, ctx);
    expect(again.ok).toBe(true);
    expect(existsSync(path.join(mount, 'lx9-logger'))).toBe(false);
    const builtin = await tool('pipeline_remove').handler({ id: 'sheet' }, ctx);
    expect(builtin.ok ? null : builtin.error).toMatch(/sheet is a built-in.*pipeline_set/);
  });
});
