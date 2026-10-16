/**
 * The retired routes' 410 stubs (arch A7): what each one answered, and what
 * its path answers once the stub is deleted. Through the FULL HTTP pipeline
 * (runRoute) with no database: the logins are stood in
 * (run-route-stand-ins.ts), as in the guard sweep.
 *
 * Every stub method (a `gone(kind)` export the manifest names, and the
 * stubs that answer through goneResponse by hand, STUB_OWN) was driven with
 * no credential, the brain owner's cookie and a member's cookie BEFORE the
 * stubs were deleted, and recorded (__snapshots__/a7-gone-routes.main.txt,
 * written with A7_GONE_RECORD=1). The answers are those of main: the guard
 * sweep (a4-guard-sweep.txt, recorded on main) holds every stub cell and
 * passed on the same commit.
 *
 * Now each recorded cell answers as recorded while its route is still
 * routed; a deleted route's cell is a named change: its path answers what a
 * path no route answers does (a sibling path, the same path with `-a7none`
 * on its last segment, driven the same way), and that answer is recorded
 * (__snapshots__/a7-gone-routes.changes.txt): a 404 for a signed-in caller,
 * the gate's 401 for no credential off the public paths.
 *
 * The stub hits a box still sees are counted by scripts/arch-scoreboard-box.sh
 * (numbers only, per stub family); docs/actors.md, "Remove the switch-over
 * code (A7)".
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { runRoute, type RouteLogin } from '@/server/run-route';
import { standInLogin } from '@/server/run-route-stand-ins';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = join(here, '__snapshots__/a7-gone-routes.main.txt');
const RECORD = process.env.A7_GONE_RECORD === '1';
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));

const OWNER = '33333333-3333-4333-8333-333333333333';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const ID = '11111111-1111-4111-8111-111111111111';

vi.mock(
  '@/lib/auth/login-row',
  async () => (await import('@/server/run-route-stand-ins')).loginRowStandIn,
);
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  // On a write row an Admin user's answer reads the database (its write
  // scope, the create home): stood in, as in the guard sweep.
  loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
  createHomeIntent: async () => ({ createWs: null, privateWs: null }),
}));
// The brain's owner holds every Admin area (no database to read them from).
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  requireArea: async () => true,
}));
// The api.write row an Admin user's write writes, kept off the database.
vi.mock('@/lib/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/audit')>()),
  auditFireAndForget: vi.fn(),
}));

/** The stubs that answer through goneResponse by hand (no `gone(kind)`
 *  export, so the manifest does not name them): each method. */
const STUB_OWN: readonly string[] = [
  'GET /api/access/nodes/:id',
  'PATCH /api/access/nodes/:id',
  'PUT /api/app-nav',
  'GET /api/auth/client-code',
  'POST /api/auth/client-code',
  'POST /api/auth/client-code/verify',
  'POST /api/auth/client-link',
  'GET /api/member/apps/:id/frame',
];

const CREDENTIALS: Readonly<Record<string, RouteLogin>> = {
  none: null,
  owner: OWNER,
  member: MEMBER,
};

/** A concrete path for a pattern: every parameter an item id. */
function concrete(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+/g, ID);
}

/** The same path with `-a7none` on its last segment: a path no route has,
 *  under the same prefix (a public prefix stays public). */
function sibling(path: string): string {
  return `${path}-a7none`;
}

/** One answer: the status, the content type and the start of the body. */
async function answer(cred: string, method: string, path: string): Promise<string> {
  const res = await runRoute(
    CREDENTIALS[cred]!,
    method,
    path,
    method === 'GET' || method === 'HEAD' ? undefined : {},
  );
  const type = (res.headers.get('content-type') ?? '').split(';')[0];
  const body = method === 'HEAD' ? '' : (await res.text()).replace(/\s+/g, ' ').slice(0, 160);
  return `${res.status} ${type} ${body}`.trim();
}

/** Every stub method of the manifest now, and the hand stubs. */
async function stubsNow(): Promise<string[]> {
  const { routeManifest } = await import('./route-manifest.gen');
  const out = new Set<string>();
  for (const e of routeManifest) for (const m of e.gone ?? []) out.add(`${m} ${e.pattern}`);
  for (const k of STUB_OWN) out.add(k);
  return [...out].sort();
}

/** Whether `method pattern` is routed now. */
async function routed(key: string): Promise<boolean> {
  const { routeManifest } = await import('./route-manifest.gen');
  const [method, pattern] = key.split(' ');
  return routeManifest.some(
    (e) =>
      e.pattern === pattern &&
      e.methods.map((m: string) => m.toUpperCase()).includes(method!.toUpperCase()),
  );
}

describe.skipIf(!hasManifest)('the retired routes (A7): recorded, then deleted', () => {
  beforeAll(() => {
    standInLogin({ id: OWNER, role: 'admin', isOwner: true });
    standInLogin({ id: MEMBER, role: 'member' });
  });

  it('each stub cell answers as recorded, or as a path no route answers once deleted', async () => {
    if (RECORD) {
      const lines: string[] = [
        '# A7: every 410 stub method, driven before the stubs were deleted (A7_GONE_RECORD=1);',
        '# a7-gone-routes.test.ts compares each cell with this, or its named change.',
      ];
      for (const key of await stubsNow()) {
        const [method, pattern] = key.split(' ');
        for (const cred of Object.keys(CREDENTIALS)) {
          lines.push(`${key} ${cred} => ${await answer(cred, method!, concrete(pattern!))}`);
        }
      }
      writeFileSync(MAIN, `${lines.join('\n')}\n`);
      return;
    }
    const recorded = readFileSync(MAIN, 'utf8')
      .split('\n')
      .filter((l) => l && !l.startsWith('#'));
    expect(recorded.length).toBeGreaterThan(300);
    const changes: string[] = [];
    let kept = 0;
    for (const line of recorded) {
      const [cell, was] = line.split(' => ') as [string, string];
      const [method, pattern, cred] = cell.split(' ') as [string, string, string];
      const path = concrete(pattern);
      const now = await answer(cred, method, path);
      if (await routed(`${method} ${pattern}`)) {
        expect(now, cell).toBe(was);
        kept += 1;
        continue;
      }
      // Deleted: the path answers what a path no route has answers.
      expect(now, cell).toBe(await answer(cred, method, sibling(path)));
      changes.push(`${cell}: ${was} -> ${now}`);
    }
    // Before the deletion every cell is kept; after it, every one changed.
    expect(kept === recorded.length || changes.length === recorded.length).toBe(true);
    if (changes.length > 0) {
      await expect(`${changes.join('\n')}\n`).toMatchFileSnapshot(
        './__snapshots__/a7-gone-routes.changes.txt',
      );
    }
  }, 300_000);
});
