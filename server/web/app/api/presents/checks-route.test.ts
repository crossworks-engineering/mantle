/**
 * GET /api/presents/:id/checks, the image check overview of a traced P&ID
 * canvas, through the full pipeline (runRoute) and the real route file: an
 * owner login gets the overview, a canvas the caller does not read is a
 * 404, no login is the gate's 401. The overview itself is stood in (its
 * own test: @mantle/tools circuit-trace/overview.test.ts).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { runRoute } from '@/server/run-route';
import { standInLogin } from '@/server/run-route-stand-ins';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const CANVAS = '11111111-1111-4111-8111-111111111111';
const MISSING = '44444444-4444-4444-8444-444444444444';
const CROP = '55555555-5555-4555-8555-555555555555';

vi.mock(
  '@/lib/auth/login-row',
  async () => (await import('@/server/run-route-stand-ins')).loginRowStandIn,
);
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  adminLoginActive: vi.fn(async () => true),
  memberLoginActive: vi.fn(async () => true),
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/db')>()),
  withViewer: vi.fn(async (_who: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@mantle/tools/present-checks', () => ({
  presentChecksOverview: vi.fn(async (_owner: string, id: string) =>
    id === CANVAS
      ? {
          traced: true,
          note: 'Image checks help; they are not a guarantee. Verify on the drawing.',
          circuits: [
            {
              circuit: '10000-001-01',
              counts: { checked: 1, no: 0, unsure: 0 },
              items: [
                {
                  kind: 'end',
                  tableId: '66666666-6666-4666-8666-666666666666',
                  sheet: 'PID-1001',
                  question: 'Does the pipe end connect to V-201?',
                  answer: 'yes',
                  reason: 'into its nozzle',
                  model: 'test/vision-model',
                  checkedAt: '2026-10-27T09:00:00.000Z',
                  crops: [CROP],
                },
              ],
            },
          ],
          limits: [],
        }
      : null,
  ),
}));

beforeAll(() => {
  process.env.SESSION_SECRET = 'present-checks-route-secret-at-least-32-chars';
  standInLogin({ id: ANCHOR, role: 'admin', adminMember: true, isOwner: true });
});

describe('GET /api/presents/:id/checks', () => {
  it('answers the overview: counts and items, crops as file ids', async () => {
    const res = await runRoute(ANCHOR, 'GET', `/api/presents/${CANVAS}/checks`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      checks: { traced: boolean; note: string; circuits: { items: { crops: string[] }[] }[] };
    };
    expect(body.checks.traced).toBe(true);
    expect(body.checks.note).toMatch(/not a guarantee/);
    expect(body.checks.circuits[0]!.items[0]!.crops).toEqual([CROP]);
  });

  it('a canvas the caller does not read is a 404; no login is a 401', async () => {
    expect((await runRoute(ANCHOR, 'GET', `/api/presents/${MISSING}/checks`)).status).toBe(404);
    expect((await runRoute(null, 'GET', `/api/presents/${CANVAS}/checks`)).status).toBe(401);
  });
});
