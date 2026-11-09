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
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const loaded: string[] = [];
const flag = (name: string) => () => {
  loaded.push(name);
  return {};
};
vi.mock('@/lib/scim/service', flag('scim/service'));
vi.mock('@/lib/scim/settings', flag('scim/settings'));
vi.mock('@/lib/scim/store', flag('scim/store'));
vi.mock('@/lib/scim/discovery', flag('scim/discovery'));
vi.mock('@/lib/control/fleet', flag('control/fleet'));
vi.mock('@/lib/control/run', flag('control/run'));
vi.mock('@/lib/control/key', flag('control/key'));
vi.mock('@mantle/db/control-center', flag('db/control-center'));
vi.mock('@/lib/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/auth')>()),
  ownerCaller: () => ({ id: 'x', email: 'x', actor: { id: 'x', email: 'x' } }),
}));

let worker: (() => Promise<unknown>) | null = null;
vi.mock('../../workers/_runner', () => ({
  runWorker: (_name: string, setup: () => Promise<unknown>) => {
    worker = setup;
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
    for (const r of [
      await fleet.GET(),
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
    expect(worker).not.toBeNull();
    expect(await worker!()).toBeUndefined();
  });

  it('SCIM boot check and auto-link stay off', async () => {
    const { scimBootCheck } = await import('../oidc/boot');
    await scimBootCheck();
  });

  it('none of it loaded any CC code', () => {
    expect(loaded).toEqual([]);
  });
});

// --- The scan ---------------------------------------------------------------

const WEB = join(__dirname, '../..');
const REPO = join(WEB, '../..');

/** The CC-only modules, as an import names them. */
const CC_ONLY = [
  /^@\/lib\/scim\//,
  /\/lib\/scim\/[a-z-]+$/,
  /^@mantle\/db\/control-center$/,
  /^(@\/lib\/control|\.)\/(fleet|run|key)$/,
  /\/lib\/control\/(fleet|run|key)$/,
  /^\.\/builtins-control$/,
];

/** The files that are CC code themselves, or a script an operator runs by
 *  hand: they may import it at top level. */
const CC_FILES = [
  /^server\/web\/lib\/scim\//,
  /^server\/web\/lib\/control\/(fleet|run|key)\.ts$/,
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
    for (const root of [
      'server/web/app',
      'server/web/lib',
      'server/web/server',
      'server/web/workers',
      'packages/tools/src',
      'packages/mcp-core/src',
    ]) {
      for (const f of files(join(REPO, root))) {
        const rel = relative(REPO, f);
        if (CC_FILES.some((r) => r.test(rel))) continue;
        const text = readFileSync(f, 'utf8');
        for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)) {
          if (CC_ONLY.some((r) => r.test(m[1]!))) found.push(`${rel}: ${m[1]}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
