/**
 * An app tool broker never hands a browser a database error's text (A5 step
 * 5 fix round 1, M3; since A5 step 3b the broker's caller, not an ungated
 * path, carries the rule). Each broker answers dispatch's result as it is
 * (server/web/app/s/[token]/tool-broker/route.ts,
 * server/web/lib/app-runner.ts, server/web/app/api/apps/[id]/tool-broker),
 * so its caller (appBrokerCaller) masks a database error in the one
 * mapper's words for every surface but the owner's own web (an app the
 * Admin workspace alone holds), which reads it as before, as the dev console
 * (ownerWebCaller) does. Each surface below is the one a broker passes
 * (appToolScope, the share broker's contact surface). A call that names no
 * caller is refused (there is no ungated path since step 3b), and so is an
 * app broker's call whose caller unmasks off the owner's web (fix round 1,
 * LOW-1: the caller's `masks` and the call's surface never disagree).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '@mantle/db';
import { DATABASE_ERROR_PUBLIC } from '@mantle/std';
import { APP_CALLER_SURFACE_ERROR, NO_TOOL_CALLER_ERROR, dispatchTool } from './dispatch';
import { appBrokerCaller, ownerWebCaller } from './gate-callers';
import { ensureGateReady } from './gate-narrowers';
import { registerBuiltin } from './registry';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const SQL = 'Failed query: select "secret" from "nodes" where "id" = $1\nparams: 4f1c';

function probe(slug: string, throws: Error): BuiltinToolDef {
  return {
    slug,
    name: slug,
    description: 'probe',
    inputSchema: { type: 'object', properties: {} },
    policy: { effect: 'read', spends: 'none', scope: 'any' },
    readOnly: true,
    handler: async () => {
      throw throws;
    },
  };
}

const row = (slug: string) =>
  ({ slug, handler: { kind: 'builtin', ref: slug } }) as unknown as Tool;

beforeAll(() => {
  ensureGateReady();
  registerBuiltin(
    probe(
      'broker_probe_db',
      Object.assign(new Error(SQL), {
        cause: Object.assign(new Error('relation "nodes" is locked'), {
          code: '55P03',
          severity: 'ERROR',
        }),
      }),
    ),
  );
  registerBuiltin(probe('broker_probe_plain', new Error('the sheet has no tab named X')));
});

const SURFACES: Array<[string, NonNullable<ToolHandlerContext['surface']>]> = [
  ['the member app broker (team)', { kind: 'team', loginId: 'l1', privateReads: false }],
  ['the shared app broker (contact)', { kind: 'contact', contactId: 'c1', shareId: 's1' }],
];

describe('an app broker call never answers a database error’s text off the owner’s web (M3)', () => {
  for (const [name, surface] of SURFACES) {
    it(`${name}: the one mapper's words, never the SQL or its params`, async () => {
      const res = await dispatchTool(
        row('broker_probe_db'),
        {},
        { ownerId: 'o', surface, caller: appBrokerCaller(surface) },
      );
      expect(res.ok).toBe(false);
      const error = (res as { error: string }).error;
      expect(error).toBe(DATABASE_ERROR_PUBLIC);
      expect(error).not.toContain('Failed query');
      expect(error).not.toContain('params');
    });

    it(`${name}: an error that is not the database's keeps its text`, async () => {
      const res = await dispatchTool(
        row('broker_probe_plain'),
        {},
        { ownerId: 'o', surface, caller: appBrokerCaller(surface) },
      );
      expect(res).toEqual({ ok: false, error: 'the sheet has no tab named X' });
    });
  }

  it("the owner's web (an Admin-only app, the dev console) reads the text as before", async () => {
    const surface = { kind: 'web' as const, loginId: 'l1' };
    for (const caller of [appBrokerCaller(surface), ownerWebCaller()]) {
      const res = await dispatchTool(row('broker_probe_db'), {}, { ownerId: 'o', surface, caller });
      expect((res as { error: string }).error, caller.entry).toContain('Failed query');
    }
  });

  it('a call that names no caller is refused, never run (A5 step 3b)', async () => {
    const res = await dispatchTool(
      row('broker_probe_plain'),
      {},
      { ownerId: 'o', surface: { kind: 'web', loginId: 'l1' } },
    );
    expect(res).toEqual({ ok: false, error: NO_TOOL_CALLER_ERROR });
  });

  it("an app caller made for the owner's web never runs on another surface (fix round 1, LOW-1)", async () => {
    const web = appBrokerCaller({ kind: 'web' });
    expect(web.masks).toBe(false);
    const others: Array<ToolHandlerContext['surface']> = [...SURFACES.map(([, s]) => s), undefined];
    for (const surface of others) {
      const res = await dispatchTool(
        row('broker_probe_db'),
        {},
        {
          ownerId: 'o',
          ...(surface ? { surface } : {}),
          caller: web,
        },
      );
      expect(res, surface?.kind ?? 'no surface').toEqual({
        ok: false,
        error: APP_CALLER_SURFACE_ERROR,
      });
    }
    // The same caller on the surface it was made for runs (and unmasks).
    const ran = await dispatchTool(
      row('broker_probe_db'),
      {},
      {
        ownerId: 'o',
        surface: { kind: 'web', loginId: 'l1' },
        caller: web,
      },
    );
    expect((ran as { error: string }).error).toContain('Failed query');
    // A masking app caller on the owner's web is no disagreement: it masks.
    const masked = await dispatchTool(
      row('broker_probe_db'),
      {},
      {
        ownerId: 'o',
        surface: { kind: 'web', loginId: 'l1' },
        caller: appBrokerCaller({ kind: 'team' }),
      },
    );
    expect((masked as { error: string }).error).toBe(DATABASE_ERROR_PUBLIC);
  });
});
