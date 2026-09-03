/**
 * Behavioural tests for the app COMPILE and SHIP path: app_build, app_publish,
 * app_db_schema_set, app_db_seed.
 *
 * `app_build` is the agent's compile loop, and two properties carry the whole
 * design. A red build must fail the CALL (an agent scanning only the top-level
 * ok would otherwise sail on to app_publish), and a red build must not touch
 * the stored build ref: "the last good preview is untouched" is a promise the
 * description makes, so the storage edge and setDraftBuild have to stay
 * uncalled on failure. A green build ships the JS (and CSS when present) to
 * object storage and records the ref with ok: true.
 *
 * `app_publish` delegates the green-build gate to the content layer, which
 * throws NoGreenBuildError. What the tool owns is surfacing that message
 * verbatim so the agent learns to build first, rather than a generic failure.
 *
 * `app_db_schema_set` guards the DDL BEFORE looking the app up, so an ATTACH
 * or PRAGMA escape never reaches the manifest. `app_db_seed` validates row
 * shape before the app lookup and threads the manifest schema into the broker
 * so a fresh database is provisioned on first seed.
 *
 * The build runner, the storage edge and the content store are stubbed; the
 * DDL guard (assertSafeScript) runs for real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    getApp: vi.fn(),
    setDraftBuild: vi.fn(),
    setManifest: vi.fn(),
    publishApp: vi.fn(),
  };
});
vi.mock('@mantle/app-build', () => ({ buildApp: vi.fn(), loadRuntimeExports: vi.fn() }));
vi.mock('@mantle/storage', () => ({ putContent: vi.fn() }));
vi.mock('@mantle/content/app-broker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/app-broker')>();
  return { ...actual, appDbSeedRows: vi.fn() };
});
vi.mock('@mantle/content/app-table-exports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content/app-table-exports')>();
  return { ...actual, scheduleAppTableExportSync: vi.fn() };
});

import { getApp, setDraftBuild, setManifest, publishApp, NoGreenBuildError } from '@mantle/content';
import { buildApp, loadRuntimeExports } from '@mantle/app-build';
import { putContent } from '@mantle/storage';
import { appDbSeedRows } from '@mantle/content/app-broker';
import { scheduleAppTableExportSync } from '@mantle/content/app-table-exports';
import { APP_TOOLS } from './builtins-apps';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const build = APP_TOOLS.find((t) => t.slug === 'app_build')!;
const publish = APP_TOOLS.find((t) => t.slug === 'app_publish')!;
const schemaSet = APP_TOOLS.find((t) => t.slug === 'app_db_schema_set')!;
const seed = APP_TOOLS.find((t) => t.slug === 'app_db_seed')!;

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

const PUBLISHED = { entry: 'App.tsx', files: { 'App.tsx': 'published' } };
const DRAFT = { entry: 'App.tsx', files: { 'App.tsx': 'draft' } };

/** An app with a staged draft and one declared tool. */
function app(overrides: Record<string, unknown> = {}) {
  return {
    id: APP_ID,
    title: 'Weather',
    source: PUBLISHED,
    draft: DRAFT,
    manifest: { toolSlugs: ['geocode'] },
    draftBuild: null,
    publishedBuild: null,
    ...overrides,
  };
}

const GREEN = {
  ok: true,
  code: 'export default 1;',
  errors: [],
  warnings: [],
  esbuildVersion: '0.25.0',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getApp).mockResolvedValue(app() as never);
  vi.mocked(loadRuntimeExports).mockResolvedValue({ react: ['useState'] } as never);
  vi.mocked(buildApp).mockResolvedValue(GREEN as never);
  vi.mocked(putContent).mockImplementation(
    async (buf: Buffer, contentType: string) =>
      ({
        key: `content/${contentType}`,
        sha256: 'sha',
        size: buf.byteLength,
        deduped: false,
      }) as never,
  );
  vi.mocked(setDraftBuild).mockResolvedValue(true as never);
  vi.mocked(setManifest).mockResolvedValue({} as never);
  vi.mocked(publishApp).mockResolvedValue(app({ draft: null }) as never);
  vi.mocked(appDbSeedRows).mockResolvedValue({ table: 'fluids', inserted: 3, deleted: 0 } as never);
});

describe('app_build', () => {
  it('refuses a blank id and reports a missing app, without invoking the runner', async () => {
    expect(errorOf(await build.handler({ id: ' ' }, ctx))).toMatch(/id is required/);
    vi.mocked(getApp).mockResolvedValue(null as never);
    expect(errorOf(await build.handler({ id: APP_ID }, ctx))).toMatch(/not found/);
    expect(buildApp).not.toHaveBeenCalled();
  });

  it('compiles the DRAFT when one is staged, with the declared tool allowlist', async () => {
    await build.handler({ id: APP_ID }, ctx);
    expect(getApp).toHaveBeenCalledWith('o1', APP_ID);
    expect(buildApp).toHaveBeenCalledWith(DRAFT, {
      declaredToolSlugs: ['geocode'],
      runtimeExports: { react: ['useState'] },
    });
  });

  it('compiles the PUBLISHED source when no draft is staged (the rebuild path)', async () => {
    // This is what lets app_build + app_publish refresh a stale bundle
    // without touching the code.
    vi.mocked(getApp).mockResolvedValue(app({ draft: null, manifest: {} }) as never);
    await build.handler({ id: APP_ID }, ctx);
    expect(buildApp).toHaveBeenCalledWith(
      PUBLISHED,
      expect.objectContaining({ declaredToolSlugs: [] }),
    );
  });

  it('ships a green build to storage and records the ref with ok: true', async () => {
    const res = await build.handler({ id: APP_ID }, ctx);
    expect(putContent).toHaveBeenCalledTimes(1);
    expect(putContent).toHaveBeenCalledWith(
      Buffer.from(GREEN.code, 'utf8'),
      'application/javascript',
    );
    expect(setDraftBuild).toHaveBeenCalledWith(
      'o1',
      APP_ID,
      expect.objectContaining({
        storageKey: 'content/application/javascript',
        sha256: 'sha',
        bytes: GREEN.code.length,
        esbuildVersion: '0.25.0',
        ok: true,
      }),
    );
    // No CSS sidecar and no warnings: neither key should be written at all.
    const ref = vi.mocked(setDraftBuild).mock.calls[0]![2];
    expect(ref).not.toHaveProperty('css');
    expect(ref).not.toHaveProperty('warnings');
    expect(outputOf(res)).toMatchObject({ id: APP_ID, build_ok: true, bytes: GREEN.code.length });
  });

  it('stores the CSS sidecar and the warning texts alongside the bundle', async () => {
    vi.mocked(buildApp).mockResolvedValue({
      ...GREEN,
      css: '.p-4{padding:1rem}',
      warnings: [{ text: 'undeclared tool slug: weather', location: null }],
    } as never);
    const res = await build.handler({ id: APP_ID }, ctx);
    expect(putContent).toHaveBeenCalledWith(Buffer.from('.p-4{padding:1rem}', 'utf8'), 'text/css');
    expect(setDraftBuild).toHaveBeenCalledWith(
      'o1',
      APP_ID,
      expect.objectContaining({
        warnings: ['undeclared tool slug: weather'],
        css: { storageKey: 'content/text/css', sha256: 'sha', bytes: 18 },
      }),
    );
    // Warnings do not fail the call; they ride along for the agent to read.
    expect(outputOf(res).build_ok).toBe(true);
  });

  it('fails the CALL on a red build and leaves the last good preview untouched', async () => {
    vi.mocked(buildApp).mockResolvedValue({
      ok: false,
      errors: [
        { text: 'Unexpected token', location: { file: 'App.tsx', line: 3, column: 7 } },
        { text: 'Cannot find module', location: null },
      ],
      warnings: [],
      esbuildVersion: '0.25.0',
    } as never);
    const res = await build.handler({ id: APP_ID }, ctx);
    const err = errorOf(res);
    expect(err).toMatch(/build failed with 2 error\(s\)/);
    expect(err).toMatch(/App\.tsx:3:7/);
    expect(err).toMatch(/Cannot find module/);
    // Nothing reached storage and the stored ref was not replaced.
    expect(putContent).not.toHaveBeenCalled();
    expect(setDraftBuild).not.toHaveBeenCalled();
  });

  it('caps the listed errors at ten and counts the rest', async () => {
    const errors = Array.from({ length: 13 }, (_, i) => ({ text: `e${i}`, location: null }));
    vi.mocked(buildApp).mockResolvedValue({
      ok: false,
      errors,
      warnings: [],
      esbuildVersion: '0.25.0',
    } as never);
    const err = errorOf(await build.handler({ id: APP_ID }, ctx));
    expect(err).toMatch(/13 error\(s\) \(\+3 more\)/);
    expect(err).toMatch(/e9/);
    expect(err).not.toMatch(/e10/);
  });

  it('surfaces a runner crash as a tool error, not a throw', async () => {
    vi.mocked(buildApp).mockRejectedValue(new Error('esbuild binary missing'));
    expect(errorOf(await build.handler({ id: APP_ID }, ctx))).toBe('esbuild binary missing');
    expect(setDraftBuild).not.toHaveBeenCalled();
  });
});

describe('app_publish', () => {
  it('refuses a blank id without touching the store', async () => {
    expect(errorOf(await publish.handler({ id: '' }, ctx))).toMatch(/id is required/);
    expect(publishApp).not.toHaveBeenCalled();
  });

  it('promotes the draft under the caller and reports the live app', async () => {
    const res = await publish.handler({ id: APP_ID }, ctx);
    expect(publishApp).toHaveBeenCalledWith('o1', APP_ID);
    expect(outputOf(res)).toMatchObject({ id: APP_ID, name: 'Weather', published: true });
    expect(outputOf(res).url).toMatch(APP_ID);
  });

  it('surfaces the no-green-build refusal with the instruction to build first', async () => {
    // The gate lives in the content layer; the tool's job is to hand the
    // agent the reason rather than a bare failure it would retry blindly.
    vi.mocked(publishApp).mockRejectedValue(new NoGreenBuildError());
    const err = errorOf(await publish.handler({ id: APP_ID }, ctx));
    expect(err).toMatch(/no successful build/);
    expect(err).toMatch(/run a build/);
  });

  it('reports a missing app as a failure', async () => {
    vi.mocked(publishApp).mockResolvedValue(null as never);
    expect(errorOf(await publish.handler({ id: APP_ID }, ctx))).toMatch(/not found/);
  });

  it('surfaces any other store failure', async () => {
    vi.mocked(publishApp).mockRejectedValue(new Error('db down'));
    expect(errorOf(await publish.handler({ id: APP_ID }, ctx))).toBe('db down');
  });
});

describe('app_db_schema_set', () => {
  const DDL = 'CREATE TABLE IF NOT EXISTS cities (name TEXT PRIMARY KEY);';

  it('requires id and schema_sql, separately reported, before any lookup', async () => {
    expect(errorOf(await schemaSet.handler({ schema_sql: DDL }, ctx))).toMatch(/id is required/);
    expect(errorOf(await schemaSet.handler({ id: APP_ID, schema_sql: '  ' }, ctx))).toMatch(
      /schema_sql is required/,
    );
    expect(getApp).not.toHaveBeenCalled();
    expect(setManifest).not.toHaveBeenCalled();
  });

  it.each([
    ['ATTACH after a valid statement', `${DDL} ATTACH DATABASE '/etc/passwd' AS x;`],
    ['a bare PRAGMA', 'PRAGMA journal_mode = OFF;'],
    ['VACUUM INTO', "VACUUM INTO '/tmp/out.db';"],
  ])('refuses %s BEFORE looking the app up', async (_label, sql) => {
    // The guard is the only thing between the model and a file-escape DDL the
    // host would run on the app's first open. It must fire ahead of any store.
    const res = await schemaSet.handler({ id: APP_ID, schema_sql: sql }, ctx);
    expect(errorOf(res)).toMatch(/statement not allowed/);
    expect(getApp).not.toHaveBeenCalled();
    expect(setManifest).not.toHaveBeenCalled();
  });

  it('allows the one read-only PRAGMA (table_info) the guard excepts', async () => {
    vi.mocked(getApp).mockResolvedValue(app({ manifest: {} }) as never);
    const res = await schemaSet.handler(
      { id: APP_ID, schema_sql: `${DDL} PRAGMA table_info(cities);` },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(setManifest).toHaveBeenCalled();
  });

  it('stores the DDL at version 1 for an app with no schema yet', async () => {
    vi.mocked(getApp).mockResolvedValue(app({ manifest: {} }) as never);
    const res = await schemaSet.handler({ id: APP_ID, schema_sql: DDL }, ctx);
    expect(getApp).toHaveBeenCalledWith('o1', APP_ID);
    expect(setManifest).toHaveBeenCalledWith('o1', APP_ID, {
      sqlite: { schemaSql: DDL, schemaVersion: 1 },
    });
    expect(outputOf(res)).toMatchObject({ id: APP_ID, schema_version: 1 });
  });

  it('bumps the version past the CURRENT one so the host re-runs the DDL', async () => {
    vi.mocked(getApp).mockResolvedValue(
      app({ manifest: { sqlite: { schemaSql: 'old', schemaVersion: 4 } } }) as never,
    );
    const res = await schemaSet.handler({ id: APP_ID, schema_sql: DDL }, ctx);
    expect(setManifest).toHaveBeenCalledWith('o1', APP_ID, {
      sqlite: { schemaSql: DDL, schemaVersion: 5 },
    });
    expect(outputOf(res).schema_version).toBe(5);
  });

  it('reports a missing app from either lookup, writing nothing', async () => {
    vi.mocked(getApp).mockResolvedValue(null as never);
    expect(errorOf(await schemaSet.handler({ id: APP_ID, schema_sql: DDL }, ctx))).toMatch(
      /not found/,
    );
    expect(setManifest).not.toHaveBeenCalled();
    vi.mocked(getApp).mockResolvedValue(app() as never);
    vi.mocked(setManifest).mockResolvedValue(null as never);
    expect(errorOf(await schemaSet.handler({ id: APP_ID, schema_sql: DDL }, ctx))).toMatch(
      /not found/,
    );
  });
});

describe('app_db_seed', () => {
  const ROWS = [
    { name: 'water', density: 1 },
    { name: 'oil', density: 0.9 },
  ];
  const SQLITE = { schemaSql: 'CREATE TABLE fluids (name TEXT, density REAL);', schemaVersion: 1 };

  beforeEach(() => {
    vi.mocked(getApp).mockResolvedValue(app({ manifest: { sqlite: SQLITE } }) as never);
  });

  it('requires id and table, separately reported', async () => {
    expect(errorOf(await seed.handler({ table: 'fluids', rows: ROWS }, ctx))).toMatch(
      /id is required/,
    );
    expect(errorOf(await seed.handler({ id: APP_ID, rows: ROWS }, ctx))).toMatch(
      /table is required/,
    );
    expect(appDbSeedRows).not.toHaveBeenCalled();
  });

  it('refuses an empty or non-array rows value before looking the app up', async () => {
    expect(errorOf(await seed.handler({ id: APP_ID, table: 'fluids', rows: [] }, ctx))).toMatch(
      /non-empty array/,
    );
    expect(errorOf(await seed.handler({ id: APP_ID, table: 'fluids', rows: 'x' }, ctx))).toMatch(
      /non-empty array/,
    );
    expect(getApp).not.toHaveBeenCalled();
  });

  it('refuses a row that is not an object, naming its index, before any store call', async () => {
    const res = await seed.handler(
      { id: APP_ID, table: 'fluids', rows: [ROWS[0], ['a'], null] },
      ctx,
    );
    expect(errorOf(res)).toMatch(/row 1 must be an object/);
    expect(getApp).not.toHaveBeenCalled();
    expect(appDbSeedRows).not.toHaveBeenCalled();
  });

  it('reports a missing app without seeding', async () => {
    vi.mocked(getApp).mockResolvedValue(null as never);
    expect(errorOf(await seed.handler({ id: APP_ID, table: 'fluids', rows: ROWS }, ctx))).toMatch(
      /not found/,
    );
    expect(appDbSeedRows).not.toHaveBeenCalled();
  });

  it('seeds under the caller with the manifest schema, appending by default', async () => {
    const res = await seed.handler({ id: APP_ID, table: ' fluids ', rows: ROWS }, ctx);
    // The manifest schema is what provisions a database that does not exist
    // yet; without it a first seed would fail on a missing table.
    expect(appDbSeedRows).toHaveBeenCalledWith(
      'o1',
      APP_ID,
      'fluids',
      ROWS,
      { replace: false },
      SQLITE,
    );
    expect(outputOf(res)).toMatchObject({ id: APP_ID, table: 'fluids', inserted: 3, deleted: 0 });
  });

  it('schedules the linked Table export refresh after a seed', async () => {
    await seed.handler({ id: APP_ID, table: 'fluids', rows: ROWS }, ctx);
    expect(scheduleAppTableExportSync).toHaveBeenCalledWith('o1', APP_ID);
  });

  it.each([
    ['exactly true', true, true],
    ['the string "true"', 'true', false],
    ['the number 1', 1, false],
  ])('empties the table first only when replace is %s', async (_label, value, expected) => {
    // `replace` wipes the table inside the same transaction; a coerced
    // truthy string from a model must not do that.
    await seed.handler({ id: APP_ID, table: 'fluids', rows: ROWS, replace: value }, ctx);
    expect(vi.mocked(appDbSeedRows).mock.calls[0]![4]).toEqual({ replace: expected });
  });

  it('surfaces a broker failure and does not schedule a sync', async () => {
    vi.mocked(appDbSeedRows).mockRejectedValue(new Error('unknown column: densty'));
    expect(errorOf(await seed.handler({ id: APP_ID, table: 'fluids', rows: ROWS }, ctx))).toBe(
      'unknown column: densty',
    );
    expect(scheduleAppTableExportSync).not.toHaveBeenCalled();
  });
});
