/**
 * CC code is never loaded off a Control Center (owner decision B,
 * 2026-11-09; docs/control-center.md). With MANTLE_IS_CONTROL_CENTER not on:
 *
 *  - every SCIM route answers the plain 404, and so does the setup screen's
 *    SCIM-token route; GET /api/users/scim answers `{ on: false }`; none of
 *    them loads SCIM's code;
 *  - every Fleet route answers 404 and loads no CC code;
 *  - the control service idles: it loads no key, no run and no CC store;
 *  - SCIM's own readers say off whatever the .env holds.
 *
 * And a scan: no module outside the CC-only set imports a CC-only module
 * at top level (a type-only import loads nothing). The control_* tools'
 * registration is pinned in packages/tools builtins-control.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const loaded: string[] = [];
  return {
    loaded,
    flag: (name: string) => () => {
      loaded.push(name);
      return {};
    },
    worker: null as (() => Promise<unknown>) | null,
  };
});
vi.mock('@/lib/scim/service', () => h.flag('scim/service')());
vi.mock('@/lib/scim/settings', () => h.flag('scim/settings')());
vi.mock('@/lib/scim/store', () => h.flag('scim/store')());
vi.mock('@/lib/scim/discovery', () => h.flag('scim/discovery')());
vi.mock('@/lib/control/fleet', () => h.flag('control/fleet')());
vi.mock('@/lib/control/run', () => h.flag('control/run')());
vi.mock('@/lib/control/key', () => h.flag('control/key')());
vi.mock('@mantle/db/control-center', () => h.flag('db/control-center')());
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  ownerCaller: () => ({ id: 'x', email: 'x', actor: { id: 'x', email: 'x' } }),
}));
vi.mock('../../workers/_runner', () => ({
  runWorker: (_name: string, setup: () => Promise<unknown>) => {
    h.worker = setup;
  },
}));

beforeAll(() => {
  vi.stubEnv('MANTLE_IS_CONTROL_CENTER', '');
  vi.stubEnv('MANTLE_SCIM_TOKEN_HASH', 'ab'.repeat(32));
  vi.stubEnv('MANTLE_OIDC_MODE', 'setup');
});
afterAll(() => vi.unstubAllEnvs());

const req = (path: string, method = 'GET') =>
  new Request(`https://box.example.invalid${path}`, {
    method,
    headers: { authorization: 'Bearer anything' },
  });
const ctx = { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' }) };

describe('off a Control Center', () => {
  it('every SCIM route answers the plain 404', async () => {
    const answers: Response[] = [];
    for (const mod of [
      await import('../../app/scim/v2/ResourceTypes/route'),
      await import('../../app/scim/v2/Schemas/route'),
      await import('../../app/scim/v2/ServiceProviderConfig/route'),
    ]) {
      answers.push(await mod.GET(req('/scim/v2/Schemas')));
    }
    const users = await import('../../app/scim/v2/Users/route');
    answers.push(await users.GET(req('/scim/v2/Users')), await users.POST(req('/scim/v2/Users')));
    const one = await import('../../app/scim/v2/Users/[id]/route');
    for (const m of ['GET', 'PATCH', 'PUT', 'DELETE'] as const) {
      answers.push(await one[m](req('/scim/v2/Users/x', m), ctx));
    }
    for (const r of answers) {
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: 'not found' });
    }
  });

  it('the SCIM-token route answers 404, and the users area says SCIM is off', async () => {
    const token = await import('../../app/api/users/sso-setup/scim-token/route');
    expect((await token.POST(req('/api/users/sso-setup/scim-token', 'POST'))).status).toBe(404);
    const scim = await import('../../app/api/users/scim/route');
    expect(await (await scim.GET()).json()).toEqual({ on: false });
  });

  it('every Fleet route answers 404', async () => {
    const fleet = await import('../../app/api/fleet/route');
    const bans = await import('../../app/api/fleet/bans/route');
    const lift = await import('../../app/api/fleet/bans/[id]/lift/route');
    const boxes = await import('../../app/api/fleet/boxes/route');
    const box = await import('../../app/api/fleet/boxes/[id]/route');
    const keys = await import('../../app/api/fleet/keys/route');
    const matrix = await import('../../app/api/fleet/matrix/route');
    const models = await import('../../app/api/fleet/models/route');
    const settings = await import('../../app/api/fleet/settings/route');
    const defaultModel = await import('../../app/api/fleet/default-model/route');
    for (const r of [
      await fleet.GET(),
      await keys.POST(req('/api/fleet/keys', 'POST')),
      await models.POST(req('/api/fleet/models', 'POST')),
      await settings.POST(req('/api/fleet/settings', 'POST')),
      await defaultModel.GET(),
      await defaultModel.PUT(req('/api/fleet/default-model', 'PUT')),
      await defaultModel.DELETE(),
      await matrix.GET(req('/api/fleet/matrix')),
      await bans.POST(req('/api/fleet/bans', 'POST')),
      await lift.POST(req('/x', 'POST'), ctx),
      await boxes.POST(req('/api/fleet/boxes', 'POST')),
      await box.DELETE(req('/x', 'DELETE'), ctx),
    ]) {
      expect(r.status).toBe(404);
    }
  });

  it('the control service idles', async () => {
    await import('../../workers/control');
    expect(h.worker).not.toBeNull();
    expect(await h.worker!()).toBeUndefined();
  });

  it('the SCIM boot check and the leaver report stay off', async () => {
    const { scimBootCheck } = await import('../oidc/boot');
    await scimBootCheck();
    vi.stubEnv('MANTLE_OIDC_MODE', 'off');
    const left = await import('../../app/api/users/[id]/left-behind/route');
    expect((await left.GET(req('/x'), ctx)).status).toBe(404);
    vi.stubEnv('MANTLE_OIDC_MODE', 'setup');
  });

  it('none of it loaded any CC code', () => {
    expect(h.loaded).toEqual([]);
  });
});

// --- The scan ---------------------------------------------------------------

const WEB = join(__dirname, '../..');
const REPO = join(WEB, '../..');

/** The CC-only modules, by their path in the repo (no extension). */
const CC_ONLY = [
  /^server\/web\/lib\/scim\//,
  /^server\/web\/lib\/control\/(fleet|run|key|collect)$/,
  /^packages\/db\/src\/control-center$/,
  /^packages\/tools\/src\/builtins-control$/,
];

/** Where an import in `file` points, as a repo path, or null for a
 *  package this scan does not follow. */
function target(file: string, spec: string): string | null {
  if (spec === '@mantle/db/control-center') return 'packages/db/src/control-center';
  if (spec.startsWith('@/')) return `server/web/${spec.slice(2)}`;
  if (spec.startsWith('.')) return relative(REPO, resolve(dirname(file), spec));
  return null;
}

/** The files that are CC code themselves, or a script an operator runs by
 *  hand: they may import it at top level. */
const CC_FILES = [
  /^server\/web\/lib\/scim\//,
  /^server\/web\/lib\/control\/(fleet|run|key|collect)\.ts$/,
  /^packages\/tools\/src\/builtins-control\.ts$/,
  /^server\/web\/scripts\/scim-token\.ts$/,
];

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name))
    .map((d) => join(d.parentPath, d.name))
    .filter((f) => !f.includes('node_modules') && !f.includes('/.next/'));
}

describe('the scan', () => {
  it('no shared module imports CC code at top level', () => {
    const found: string[] = [];
    const inCcCode: string[] = [];
    for (const root of [
      'server/web/app',
      'server/web/lib',
      'server/web/server',
      'server/web/workers',
      'server/api/src',
      'server/mcp',
      'packages/tools/src',
      'packages/mcp-core/src',
      'packages/runtime/src',
      'packages/db/src',
    ]) {
      for (const f of files(join(REPO, root))) {
        const rel = relative(REPO, f);
        const own = CC_FILES.some((r) => r.test(rel));
        const text = readFileSync(f, 'utf8');
        // A static import or re-export, a side-effect import, or a top-level
        // (not indented) await import: each loads the module at once.
        for (const m of text.matchAll(
          /^(?:(?:import|export)\s+(?!type\b)[^;]*?from\s+|import\s+|\S[^\n]*\bawait import\()'([^']+)'/gm,
        )) {
          const to = target(f, m[1]!);
          if (to && CC_ONLY.some((r) => r.test(to)))
            (own ? inCcCode : found).push(`${rel}: ${m[1]}`);
        }
      }
    }
    expect(found).toEqual([]);
    // The scan does see an import: CC code imports CC code.
    expect(inCcCode).toContain('server/web/lib/control/fleet.ts: @mantle/db/control-center');
  });
});
