/**
 * The gate's step 6 (@mantle/db gate.ts createHomeStep) against the HTTP
 * guard's create home (session.ts createHomeFor, arch A3c fix round 1, M2):
 * for every write a route of the manifest serves, each kind of login and
 * each `?ws=`, the gate with the HTTP entry's rule (ownWork by the login, a
 * refusal refuses) and the route's two policy fields (creates, makesItems:
 * what A4's route rows carry) asks the one create-home intent exactly what
 * createHomeFor asks it. The intent itself is stubbed: it records.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ calls: [] as unknown[][] }));

vi.mock('../../../../packages/db/src/create-home', () => ({
  createHomeIntent: vi.fn(async (...args: unknown[]) => {
    h.calls.push(args);
    return { createWs: null, privateWs: null };
  }),
}));

import { loginActor, type GatePolicy } from '@mantle/db';
import { createHomeStep } from '../../../../packages/db/src/gate';
import { buildRouteRow, routeGatePolicy } from './route-policy';
import { requestCreateHomeArgs } from './session';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, '../../server/route-manifest.gen.ts'));

const LOGIN = '55555555-5555-4555-8555-555555555555';
const ID = '33333333-3333-4333-8333-333333333333';
const WS = '44444444-4444-4444-8444-444444444444';

/** A concrete path for a manifest pattern: every param an id. */
function pathOf(pattern: string): string {
  return pattern.replace(/:[A-Za-z0-9_]+/g, ID).replace(/\*$/, 'x');
}

/** An ask with no workspace is no ask: createHomeIntent answers both
 *  alike (create-home.test.ts, "absent or blank"). */
function normalized(args: unknown[]): unknown[] {
  const [login, ask, fallback] = args as [string, { ws?: unknown } | null, unknown];
  const none = !ask || ask.ws === null || ask.ws === undefined || ask.ws === '';
  return [login, none ? null : ask, fallback];
}

beforeEach(() => {
  h.calls = [];
});

describe.skipIf(!hasManifest)('step 6 with the HTTP rule equals createHomeFor', () => {
  it('for every write route, login kind and ?ws=', async () => {
    const { routeManifest } = await import('../../server/route-manifest.gen');
    // A read is its row's effect (S9 part 3: the lists are gone).
    const { isReadRequest } = (await import('../../server/test-support')).rowAnswers(routeManifest);
    let cells = 0;
    for (const e of routeManifest) {
      if (!e.pattern.startsWith('/api/')) continue;
      for (const method of e.methods) {
        if (isReadRequest(method, e.pattern)) continue;
        const path = pathOf(e.pattern);
        for (const ownWork of [true, false]) {
          for (const ws of [null, WS, 'not-an-id', '']) {
            const url = `http://brain.test${path}${ws === null ? '' : `?ws=${ws}`}`;
            // The guard and the gate read the same ROUTE_POLICY row (A4 step
            // 1); the gate's policy is the route source's own.
            const row = buildRouteRow(method, e.pattern, () => false, {
              reads: e.reads?.[method] ?? null,
              gone: e.gone?.includes(method) === true,
            });
            const today = requestCreateHomeArgs(LOGIN, row, url, ownWork);
            const policy: GatePolicy = routeGatePolicy(row);
            expect(policy.effect).toBe('write');
            h.calls = [];
            await createHomeStep(
              { actor: loginActor(LOGIN), via: 'cookie', loginId: LOGIN, createHome: { ownWork } },
              policy,
              { from: 'param', ws },
            );
            const label = `${method} ${e.pattern} ownWork=${ownWork} ws=${String(ws)}`;
            expect(h.calls.length, label).toBe(1);
            expect(normalized(h.calls[0]!), label).toEqual(normalized(today));
            cells += 1;
          }
        }
      }
    }
    expect(cells).toBeGreaterThan(500);
  });
});
