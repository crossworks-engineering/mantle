/** The one mapper of a refusal to the wire (arch A3a and A3c, plan 10). */
import { describe, expect, it } from 'vitest';
import { AccessError } from '@mantle/std';
import { scopeRefusalResponse } from './scope-refusal';

const refusal = (message: string, detail?: string) =>
  Object.assign(new Error(message), { code: '42501', ...(detail ? { detail } : {}) });

describe('scopeRefusalResponse', () => {
  it('reads the edit check detail into status, reason and code', async () => {
    const cases: [Error, number, string, string][] = [
      [refusal('not allowed to change this item', 'no_read'), 404, 'not-found', 'not_found'],
      [refusal("not allowed to write this app's data", 'read_only'), 403, 'read-only', 'read_only'],
      [
        refusal('not allowed to change anything: this caller only reads', 'ro_actor'),
        403,
        'read-only',
        'ro_actor',
      ],
      [
        refusal(
          "not allowed to change this app's code: a Moderator of its workspace does",
          'no_edit',
        ),
        403,
        'item-workspace',
        'forbidden',
      ],
      // A refusal of the checks before A3a carries no detail: as before.
      [refusal('not allowed to move this item'), 403, 'item-workspace', 'forbidden'],
      // A folder that holds items the caller cannot move (0282): 409.
      [
        refusal('This folder holds items you cannot move.', 'hidden_rows'),
        409,
        'hidden-items',
        'hidden_items',
      ],
    ];
    for (const [err, status, reason, code] of cases) {
      const res = scopeRefusalResponse(err)!;
      expect(res.status, err.message).toBe(status);
      expect(await res.json(), err.message).toMatchObject({ reason, code });
    }
  });
  it('anything else is not a refusal', () => {
    expect(scopeRefusalResponse(new Error('boom'))).toBeNull();
    expect(scopeRefusalResponse(refusal('permission denied for table secrets'))).toBeNull();
  });
});

describe('a refusal on a page', () => {
  it('a database refusal on a page is the page own error, as before', () => {
    const err = Object.assign(new Error('not allowed to move this item'), { code: '42501' });
    expect(scopeRefusalResponse(err, '/s/x')).toBeNull();
    expect(scopeRefusalResponse(err, '/print/x')).toBeNull();
  });

  it('leaves every other error alone', () => {
    expect(scopeRefusalResponse(new Error('boom'), '/api/x')).toBeNull();
    expect(scopeRefusalResponse('nope', '/api/x')).toBeNull();
  });
});

describe('a refusal of the gate (AccessError) on /api', () => {
  it('answers the bodies the guards answer today', async () => {
    const cases: [AccessError, number, Record<string, unknown>][] = [
      [new AccessError('unauthorized'), 401, { error: 'unauthorized' }],
      [
        new AccessError('unclassified'),
        403,
        { error: 'forbidden', reason: 'unclassified-route', message: 'This route is not open.' },
      ],
      [
        new AccessError('area', undefined, { area: 'users' }),
        403,
        {
          error: 'forbidden',
          reason: 'area',
          area: 'users',
          message: 'You cannot manage this part of the brain.',
        },
      ],
      [
        new AccessError('workspace', 'You are not in that workspace.'),
        403,
        { error: 'forbidden', reason: 'workspace', message: 'You are not in that workspace.' },
      ],
      [
        new AccessError('invalid', 'ws must be a workspace id.'),
        400,
        { error: 'invalid', message: 'ws must be a workspace id.' },
      ],
    ];
    for (const [err, status, body] of cases) {
      const res = scopeRefusalResponse(err)!;
      expect(res.status, err.kind).toBe(status);
      expect(await res.json(), err.kind).toEqual(body);
    }
  });
});
