/**
 * An app broker's allowed call runs on its `app-tool` ref first (A5 step
 * 6a, carried LOW-2 of step 3b): the ref carries the verdict that allowed it
 * and the caller the rules it was judged at (`facts.appRules`), as
 * appToolRefusal asks a refused call, so the member-app narrower judges the
 * run it lets through by the rule it refuses with. Then the call runs on its
 * own ref, as before (server/web/lib/app-broker-parity.test.ts holds every
 * broker's answers byte for byte). No other entry, and no call nested in an
 * app call, takes the app-tool ref.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  seen: [] as { kind: string; appRules: unknown; verdict: unknown }[],
}));

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...real,
    enterCall: ((caller, ref, fn, input) => {
      const c = typeof caller === 'function' ? null : caller;
      h.seen.push({
        kind: ref.kind,
        appRules: c?.facts?.appRules,
        verdict: (ref.verdict as { ok?: boolean } | undefined)?.ok,
      });
      return real.enterCall(caller, ref, fn, input);
    }) as typeof real.enterCall,
  };
});

import type { Tool } from '@mantle/db';
import { dispatchTool } from './dispatch';
import { appBrokerCaller, ownerWebCaller, turnCaller } from './gate-callers';
import { ensureGateReady } from './gate-narrowers';
import { registerBuiltin } from './registry';
import type { ToolHandlerContext } from './types';

const row = (slug: string) =>
  ({ slug, handler: { kind: 'builtin', ref: slug } }) as unknown as Tool;

beforeAll(() => {
  ensureGateReady();
  registerBuiltin({
    slug: 'app_run_probe',
    name: 'probe',
    description: 'probe',
    inputSchema: { type: 'object', properties: {} },
    policy: { effect: 'read', spends: 'none', scope: 'any' },
    handler: async () => ({ ok: true, output: 'ran' }),
  });
});

beforeEach(() => {
  h.seen = [];
});

const SURFACES: Array<[string, NonNullable<ToolHandlerContext['surface']>, string]> = [
  ['a member run (team rules)', { kind: 'team', loginId: 'l1', privateReads: false }, 'team'],
  ['an admin run (admin rules)', { kind: 'web', loginId: 'l1' }, 'admin'],
  ['a shared link (contact rules)', { kind: 'contact', contactId: 'c1', shareId: 's1' }, 'contact'],
];

describe("an app broker's allowed call is judged on its app-tool ref (carried LOW-2)", () => {
  for (const [name, surface, rules] of SURFACES) {
    it(`${name}: the app-tool ref with the verdict and the rules, then the tool's own`, async () => {
      const res = await dispatchTool(
        row('app_run_probe'),
        {},
        { ownerId: 'o', surface, caller: appBrokerCaller(surface) },
      );
      expect(res).toEqual({ ok: true, output: 'ran' });
      expect(h.seen).toEqual([
        { kind: 'app-tool', appRules: rules, verdict: true },
        { kind: 'tool', appRules: undefined, verdict: undefined },
      ]);
    });
  }

  it('no other entry takes the app-tool ref', async () => {
    for (const caller of [ownerWebCaller(), turnCaller()]) {
      h.seen = [];
      await dispatchTool(
        row('app_run_probe'),
        {},
        {
          ownerId: 'o',
          surface: { kind: 'web', loginId: 'l1' },
          caller,
        },
      );
      expect(h.seen.map((s) => s.kind)).toEqual(['tool']);
    }
  });
});
