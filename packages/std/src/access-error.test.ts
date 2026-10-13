/**
 * THE one mapper (arch A3c, plan 10): one reading of every refusal, for the
 * HTTP layer and the tools, with each surface's answer as before A3c.
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_KIND_CREATE_ERROR,
  ADMIN_ONLY_ERROR,
  AccessError,
  DATABASE_ERROR_PUBLIC,
  HIDDEN_ROWS_PUBLIC,
  adminAreaError,
  isAccessError,
  mapAccessError,
} from './access-error';
import { databaseErrorPublic } from './index';

const pgError = (message: string, detail?: string, code = '42501') =>
  Object.assign(new Error(message), { code, severity: 'ERROR', ...(detail ? { detail } : {}) });

/** The tool text before A3c (std index.ts databaseErrorPublic, frozen). */
function toolTextBefore(err: unknown): string {
  let e: unknown = err;
  let pg: { code?: unknown; detail?: unknown } | null = null;
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
      pg = e as { code?: unknown; detail?: unknown };
      break;
    }
    e = (e as { cause?: unknown }).cause;
  }
  if (pg?.code === '42501' && pg.detail === 'no_read') return 'not found';
  if (pg?.code === '42501' && pg.detail === 'hidden_rows') return HIDDEN_ROWS_PUBLIC;
  return DATABASE_ERROR_PUBLIC;
}

const DATABASE_CASES: unknown[] = [
  pgError('not allowed to change this item', 'no_read'),
  pgError('not allowed to edit this item', 'no_edit'),
  pgError("not allowed to write this app's data", 'read_only'),
  pgError('not allowed to change anything: this caller only reads', 'ro_actor'),
  pgError('not allowed to move this item'),
  pgError('This folder holds items you cannot move.', 'hidden_rows'),
  pgError('new row violates row-level security policy for table "nodes"'),
  pgError('permission denied for table secrets'),
  // A no_read detail on a message the workspace checks do not send.
  pgError('something else', 'no_read'),
  pgError('duplicate key value violates unique constraint', undefined, '23505'),
  // Wrapped by drizzle: the driver's error is the cause.
  Object.assign(new Error('Failed query: update nodes ...'), {
    name: 'DrizzleQueryError',
    cause: pgError('not allowed to change this item', 'no_read'),
  }),
  new Error('boom'),
];

describe('mapAccessError: the tool text', () => {
  it('is what databaseErrorPublic said before A3c, for every database error', () => {
    for (const err of DATABASE_CASES) {
      expect(databaseErrorPublic(err), (err as Error).message).toBe(toolTextBefore(err));
    }
  });

  it('a gate refusal says its own words', () => {
    expect(mapAccessError(new AccessError('admin'))?.toolText).toBe(ADMIN_ONLY_ERROR);
    expect(mapAccessError(new AccessError('admin-kind'))?.toolText).toBe(ADMIN_KIND_CREATE_ERROR);
    expect(mapAccessError(new AccessError('area', undefined, { area: 'keys' }))?.toolText).toBe(
      adminAreaError('keys'),
    );
    expect(mapAccessError(new AccessError('narrowed', 'not on a read key'))?.toolText).toBe(
      'not on a read key',
    );
  });
});

describe('mapAccessError: the HTTP answer', () => {
  it('a database refusal needs a workspace check message; a missing grant stays a 500', () => {
    expect(mapAccessError(pgError('permission denied for table secrets'))).toBeNull();
    expect(mapAccessError(pgError('something else', 'no_read'))?.http).toBeNull();
    expect(mapAccessError(new Error('boom'))).toBeNull();
    expect(
      mapAccessError(pgError('duplicate key value violates unique constraint', undefined, '23505')),
    ).toBeNull();
  });

  it('reads the edit check detail into status, reason and code', () => {
    const cases: [unknown, number, string, string][] = [
      [pgError('not allowed to change this item', 'no_read'), 404, 'not-found', 'not_found'],
      [pgError("not allowed to write this app's data", 'read_only'), 403, 'read-only', 'read_only'],
      [
        pgError('not allowed to change anything: this caller only reads', 'ro_actor'),
        403,
        'read-only',
        'ro_actor',
      ],
      [pgError('not allowed to edit this item', 'no_edit'), 403, 'item-workspace', 'forbidden'],
      [pgError('not allowed to move this item'), 403, 'item-workspace', 'forbidden'],
      [
        pgError('This folder holds items you cannot move.', 'hidden_rows'),
        409,
        'hidden-items',
        'hidden_items',
      ],
    ];
    for (const [err, status, reason, code] of cases) {
      const r = mapAccessError(err)!;
      expect(r.http?.status, (err as Error).message).toBe(status);
      expect(r.http?.body, (err as Error).message).toMatchObject({ reason, code });
      expect(r.code).toBe(code);
    }
  });

  it('finds a gate refusal below a wrapper, and by its brand', () => {
    const inner = new AccessError('unauthorized');
    expect(mapAccessError(new Error('wrapped', { cause: inner }))?.http?.status).toBe(401);
    expect(isAccessError(inner)).toBe(true);
    expect(isAccessError(new Error('x'))).toBe(false);
    expect(isAccessError({ kind: 'admin' })).toBe(false);
  });
});
