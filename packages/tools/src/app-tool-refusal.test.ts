/**
 * What the app tool brokers answer for a call their verdict refused (A5
 * step 3b, appToolRefusal): a missing tool 404 before the gate (no row, no
 * ref); every other refusal the one gate's (gateCallRefusal on the call's
 * `app-tool` ref), a narrowed 403 in the verdict's words, at every rules a
 * broker judges at (an admin's run, a member's, a contact's). The same
 * status and body the brokers answered from the verdict before.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ gateCalls: [] as Array<{ caller: unknown; ref: unknown }> }));

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...real,
    gateCallRefusal: async (...args: Parameters<typeof real.gateCallRefusal>) => {
      h.gateCalls.push({ caller: args[0], ref: args[1] });
      return real.gateCallRefusal(...args);
    },
  };
});

import { loginActor, runAsActor } from '@mantle/db';
import { APP_NO_TOOLS, appToolRefusal, type AppCallRules } from './app-tool-level';
import { ensureGateReady } from './gate-narrowers';

const LOGIN = '00000000-0000-4000-8000-000000000009';

beforeAll(() => ensureGateReady());
beforeEach(() => {
  h.gateCalls.length = 0;
});

const REFUSED: Array<[AppCallRules, string]> = [
  [
    'admin',
    "This app isn't allowed to use the tool 'x'. It must be declared in the app's tools before it can run.",
  ],
  ['team', "The tool 'x' changes data or reaches outside the brain, so a team app can't use it."],
  ['contact', "The tool 'x' is built in, and a shared link runs no built-in tools."],
  ['none', APP_NO_TOOLS],
];

describe('appToolRefusal (A5 step 3b)', () => {
  it('a missing tool answers 404 before the gate', async () => {
    for (const [rules] of REFUSED) {
      const out = await appToolRefusal(rules, 'x', {
        ok: false,
        status: 404,
        reason: "tool 'x' not found",
      });
      expect(out).toEqual({ status: 404, error: "tool 'x' not found" });
    }
    expect(h.gateCalls).toEqual([]);
  });

  it.each(REFUSED)(
    'at %s rules: the gate refuses in the verdict’s words, a 403',
    async (rules, reason) => {
      const actor = loginActor(LOGIN, 'rw');
      const out = await runAsActor(actor, () =>
        appToolRefusal(rules, 'x', { ok: false, status: 403, reason }),
      );
      expect(out).toEqual({ status: 403, error: reason });
      expect(h.gateCalls).toHaveLength(1);
      // The broker's caller: the actor bound at its entry, the rules it judged at.
      expect(h.gateCalls[0]).toMatchObject({
        caller: {
          actor,
          via: rules === 'contact' ? 'contact' : 'app',
          facts: { appRules: rules },
        },
        ref: { kind: 'app-tool', name: 'x', verdict: { ok: false, status: 403, reason } },
      });
    },
  );
});
