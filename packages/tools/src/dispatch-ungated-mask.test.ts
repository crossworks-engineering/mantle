/**
 * The entries that name no caller yet (the app tool brokers, the dev
 * console; A5 step 3b moves them) never hand a browser a database error's
 * text (A5 step 5 fix round 1, M3). Each broker answers dispatch's result
 * as it is (server/web/app/s/[token]/tool-broker/route.ts,
 * server/web/lib/app-runner.ts, server/web/app/api/apps/[id]/tool-broker),
 * so dispatch masks an ungated call's database error in the one mapper's
 * words for every surface but the owner's own web (the dev console and an
 * app the Admin workspace alone holds), which reads it as before. Each
 * surface below is the one a broker passes (appToolScope, the share
 * broker's contact surface).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Tool } from '@mantle/db';
import { DATABASE_ERROR_PUBLIC } from '@mantle/std';
import { dispatchTool } from './dispatch';
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
      'ungated_probe_db',
      Object.assign(new Error(SQL), {
        cause: Object.assign(new Error('relation "nodes" is locked'), {
          code: '55P03',
          severity: 'ERROR',
        }),
      }),
    ),
  );
  registerBuiltin(probe('ungated_probe_plain', new Error('the sheet has no tab named X')));
});

const SURFACES: Array<[string, NonNullable<ToolHandlerContext['surface']>]> = [
  ['the member app broker (team)', { kind: 'team', loginId: 'l1', privateReads: false }],
  ['the shared app broker (contact)', { kind: 'contact', contactId: 'c1', shareId: 's1' }],
];

describe('an ungated call never answers a database error’s text off the owner’s web (M3)', () => {
  for (const [name, surface] of SURFACES) {
    it(`${name}: the one mapper's words, never the SQL or its params`, async () => {
      const res = await dispatchTool(row('ungated_probe_db'), {}, { ownerId: 'o', surface });
      expect(res.ok).toBe(false);
      const error = (res as { error: string }).error;
      expect(error).toBe(DATABASE_ERROR_PUBLIC);
      expect(error).not.toContain('Failed query');
      expect(error).not.toContain('params');
    });

    it(`${name}: an error that is not the database's keeps its text`, async () => {
      const res = await dispatchTool(row('ungated_probe_plain'), {}, { ownerId: 'o', surface });
      expect(res).toEqual({ ok: false, error: 'the sheet has no tab named X' });
    });
  }

  it("the owner's web (the dev console, an Admin-only app) reads the text as before", async () => {
    const res = await dispatchTool(
      row('ungated_probe_db'),
      {},
      { ownerId: 'o', surface: { kind: 'web', loginId: 'l1' } },
    );
    expect((res as { error: string }).error).toContain('Failed query');
  });
});
