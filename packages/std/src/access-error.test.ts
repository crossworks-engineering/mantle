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

/** The tool text since A5 step 5 (owner decision Q3 b): a read-only or an
 *  item-workspace refusal says the HTTP answer's words; every other case
 *  says what it said before A3c. */
const Q3_TOOL_TEXT: ReadonlyMap<string, string> = new Map([
  ["not allowed to write this app's data", 'This app is Informational: its data is read only.'],
  [
    'not allowed to change anything: this caller only reads',
    'This caller only reads: it cannot change anything.',
  ],
  ['not allowed to edit this item', 'You cannot change this item in your workspaces.'],
  ['not allowed to move this item', 'You cannot change this item in your workspaces.'],
  [
    'new row violates row-level security policy for table "nodes"',
    'You cannot change this item in your workspaces.',
  ],
]);

describe('mapAccessError: the tool text', () => {
  it('is what databaseErrorPublic said before A3c, but the reasons Q3 names (A5 step 5)', () => {
    let changed = 0;
    for (const err of DATABASE_CASES) {
      const message = (err as Error).message;
      const now = Q3_TOOL_TEXT.get(message);
      if (now !== undefined) {
        expect(toolTextBefore(err), message).toBe(DATABASE_ERROR_PUBLIC);
        changed += 1;
      }
      expect(databaseErrorPublic(err), message).toBe(now ?? toolTextBefore(err));
    }
    expect(changed).toBe(Q3_TOOL_TEXT.size);
  });

  it('a read-only or item-workspace refusal says the HTTP message; no_read stays not found', () => {
    for (const err of DATABASE_CASES) {
      const r = mapAccessError(err);
      if (!r || r.kind !== 'database' || !r.http) continue;
      const message = (r.http.body as { message?: string; error?: string }).message;
      if (r.http.status === 403) expect(r.toolText, (err as Error).message).toBe(message);
    }
    expect(databaseErrorPublic(pgError('not allowed to change this item', 'no_read'))).toBe(
      'not found',
    );
    expect(
      databaseErrorPublic(pgError('This folder holds items you cannot move.', 'hidden_rows')),
    ).toBe(HIDDEN_ROWS_PUBLIC);
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

  it('the bodies, byte for byte (unchanged by A5 step 5, Q3)', () => {
    const body = (err: unknown) => JSON.stringify(mapAccessError(err)?.http?.body);
    expect(body(pgError('not allowed to change this item', 'no_read'))).toBe(
      '{"error":"not found","reason":"not-found","code":"not_found","message":"Not found."}',
    );
    expect(body(pgError("not allowed to write this app's data", 'read_only'))).toBe(
      '{"error":"forbidden","reason":"read-only","code":"read_only","message":"This app is Informational: its data is read only."}',
    );
    expect(
      body(pgError('not allowed to change anything: this caller only reads', 'ro_actor')),
    ).toBe(
      '{"error":"forbidden","reason":"read-only","code":"ro_actor","message":"This caller only reads: it cannot change anything."}',
    );
    const itemWorkspace =
      '{"error":"forbidden","reason":"item-workspace","code":"forbidden","message":"You cannot change this item in your workspaces."}';
    expect(body(pgError('not allowed to edit this item', 'no_edit'))).toBe(itemWorkspace);
    expect(body(pgError('not allowed to move this item'))).toBe(itemWorkspace);
    expect(body(pgError('This folder holds items you cannot move.', 'hidden_rows'))).toBe(
      '{"error":"This folder holds items you cannot move.","reason":"hidden-items","code":"hidden_items"}',
    );
  });

  it('finds a gate refusal below a wrapper, and by its brand', () => {
    const inner = new AccessError('unauthorized');
    expect(mapAccessError(new Error('wrapped', { cause: inner }))?.http?.status).toBe(401);
    expect(isAccessError(inner)).toBe(true);
    expect(isAccessError(new Error('x'))).toBe(false);
    expect(isAccessError({ kind: 'admin' })).toBe(false);
  });
});
