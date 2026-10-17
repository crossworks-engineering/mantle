/**
 * A /api/v1 builtin route whose handler throws (workspaces arch A5 step 4
 * fix round 1, M1): the error goes on to app.onError, which answers it as
 * it did before the route ran through dispatch: a database error is the
 * opaque 500, an edit check refusal its 403 or 404. Never a 400 that reads
 * the error's text out (the SQL, its params). A handler's own refusal (it
 * returns, never throws) stays the route's 400. And a table the item check
 * refuses answers its exact body: 403 item-workspace for one the scope
 * reads but may not change, 404 for one it does not read. (Fix round 2
 * pinned the gate's item pre-check here; the pre-check removal took it, so
 * the refusal is the library's, assertItemRight, or the database's, one
 * error for both. In the running app the HTTP item gate, itemWriteGate in
 * lib/auth/session.ts, answers such a write first with its own 403 or 404;
 * this file stands the HTTP gate aside.)
 * Since pre-check removal part 2 the HTTP gate names no table route: the
 * route reads the table in the key's scope and asks its edit
 * (assertItemRight) before the tool runs, pinned last here.
 *
 * The routes run behind the app's own error answer (server/app-error.ts);
 * the session, the key's hidden items and the two tools' handlers are
 * stood in (the tools keep their slugs, with a policy that reads nothing).
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureGateReady, getBuiltin, registerBuiltin, type BuiltinToolDef } from '@mantle/tools';
import { AccessError, editCheckRefusalError } from '@mantle/std';
import { answerAppError } from '@/server/app-error';
import { POST } from '@/app/api/v1/tables/[id]/rows/route';
import { PATCH } from '@/app/api/v1/tables/[id]/rows/[rowId]/route';

const OWNER = '00000000-0000-4000-8000-000000000001';
const TABLE = '20000000-0000-4000-8000-000000000001';

const h = vi.hoisted(() => ({
  fail: null as unknown,
  refuse: null as string | null,
  preFail: null as unknown,
  /** The table's title in the key's scope (null: the scope does not read it). */
  title: 'T' as string | null,
  /** What the route's own edit check answers (null: the scope may edit). */
  right: null as 'no_read' | 'no_edit' | 'copy' | null,
}));

// The route reads the table in the key's scope first (pre-check removal
// part 2): stood in, a table the scope reads unless a cell says not.
vi.mock('@mantle/content/table-snapshots', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tableTitle: async () => h.title,
}));

// Then it asks the table's edit (assertItemRight): stood in, to throw what
// the real one throws for each verdict.
vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  const { editCheckRefusalError } = await import('@mantle/std');
  return {
    ...real,
    assertItemRight: async () => {
      if (h.right === 'copy') throw new real.SnapshotCopyReadOnlyError();
      if (h.right) throw editCheckRefusalError(h.right);
    },
  };
});

// The tools' preconditions (a table id names a table) read the database:
// stood in, to pass, or to throw what a failed lookup throws.
vi.mock('../../../packages/tools/src/preconditions', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkToolPreconditions: async () => {
    if (h.preFail) throw h.preFail;
    return null;
  },
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: OWNER,
    actor: { id: OWNER, displayName: 'Admin' },
  })),
  // The v1 rows routes read the caller the pipeline answers (A4 step 3b).
  ownerCaller: vi.fn(() => ({
    id: OWNER,
    actor: { id: OWNER, displayName: 'Admin' },
  })),
}));

vi.mock('@/lib/api-v1', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hiddenFromKey: async () => new Set<string>(),
}));

/** What drizzle throws for a failed statement: the query and its params in
 *  the message, the driver error as cause. */
const drizzleError = (code: string, message: string, detail?: string) =>
  Object.assign(new Error('Failed query: insert into nodes values ($1)\nparams: SECRET'), {
    cause: Object.assign(new Error(message), { code, severity: 'ERROR', detail }),
  });

const SLUGS = ['table_rows_add', 'table_row_update'] as const;
const saved = new Map<string, BuiltinToolDef>();

function standIn(real: BuiltinToolDef): BuiltinToolDef {
  return {
    ...real,
    policy: { effect: 'write', spends: 'none', scope: 'any' },
    handler: async () => {
      if (h.refuse) return { ok: false, error: h.refuse };
      if (h.fail) throw h.fail;
      return { ok: true, output: { ok: true } };
    },
  };
}

let app: Hono;

beforeAll(() => {
  ensureGateReady();
  for (const slug of SLUGS) {
    const real = getBuiltin(slug);
    if (!real) throw new Error(`${slug} is not registered`);
    saved.set(slug, real);
    registerBuiltin(standIn(real));
  }
  app = new Hono();
  app.post('/api/v1/tables/:id/rows', (c) =>
    POST(c.req.raw, { params: Promise.resolve({ id: c.req.param('id') }) }),
  );
  app.patch('/api/v1/tables/:id/rows/:rowId', (c) =>
    PATCH(c.req.raw, {
      params: Promise.resolve({ id: c.req.param('id'), rowId: c.req.param('rowId') }),
    }),
  );
  app.onError(answerAppError);
});
afterAll(() => {
  for (const def of saved.values()) registerBuiltin(def);
});

const post = () =>
  app.request(`/api/v1/tables/${TABLE}/rows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rows: [{ a: 1 }] }),
  });
const patch = () =>
  app.request(`/api/v1/tables/${TABLE}/rows/r1`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cells: { a: 2 } }),
  });

async function answer(
  send: () => Response | Promise<Response>,
  fail: unknown,
  refuse: string | null = null,
  preFail: unknown = null,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  h.fail = fail;
  h.refuse = refuse;
  h.preFail = preFail;
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const res = await send();
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
  } finally {
    quiet.mockRestore();
    h.fail = null;
    h.refuse = null;
    h.preFail = null;
    h.title = 'T';
    h.right = null;
  }
}

describe.each([
  ['POST /api/v1/tables/:id/rows', post],
  ['PATCH /api/v1/tables/:id/rows/:rowId', patch],
])('%s: a handler that throws answers as before dispatch (A5 step 4 M1)', (_name, send) => {
  it('a database error with its query and params is the opaque 500', async () => {
    const res = await answer(send, drizzleError('23505', 'duplicate key value'));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
    expect(res.text).not.toMatch(/SECRET|insert into|Failed query/);
  });

  it('an edit check refusal (42501 no_edit) is 403 item-workspace', async () => {
    const res = await answer(
      send,
      drizzleError('42501', 'not allowed to edit this item', 'no_edit'),
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'forbidden', reason: 'item-workspace' });
    expect(res.text).not.toMatch(/SECRET|insert into|Failed query/);
  });

  it('an edit check refusal of an item the caller does not read (no_read) is 404', async () => {
    const res = await answer(
      send,
      drizzleError('42501', 'not allowed to edit this item', 'no_read'),
    );
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not found', reason: 'not-found' });
    expect(res.text).not.toMatch(/SECRET|insert into|Failed query/);
  });

  it('a read-only caller (ro_actor) is 403 read-only', async () => {
    const res = await answer(
      send,
      drizzleError('42501', 'not allowed to change this item', 'ro_actor'),
    );
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'forbidden', reason: 'read-only', code: 'ro_actor' });
  });

  it('any other throw is the opaque 500, never its message', async () => {
    const res = await answer(send, new Error('boom with params: SECRET'));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
  });

  it('a gate refusal the handler throws (AccessError) is its mapped answer', async () => {
    const res = await answer(send, new AccessError('item', 'You cannot change this item.'));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: 'forbidden',
      reason: 'item',
      message: 'You cannot change this item.',
    });
  });

  it('a database error the precondition check throws is the opaque 500', async () => {
    const res = await answer(send, null, null, drizzleError('XX000', 'lookup failed'));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal error' });
    expect(res.text).not.toMatch(/SECRET|insert into|Failed query/);
  });

  it('the handler’s own refusal (returned, not thrown) stays its 400', async () => {
    const res = await answer(send, null, 'Table not found');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Table not found' });
  });
});

/** What the item check answers for a write to a table the key's scope
 *  reads but may not change (42501 no_edit, through app.onError). */
const ITEM_WORKSPACE = {
  error: 'forbidden',
  reason: 'item-workspace',
  code: 'forbidden',
  message: 'You cannot change this item in your workspaces.',
};
/** And for a table it does not read: 42501 no_read, the 404. */
const NOT_FOUND = {
  error: 'not found',
  reason: 'not-found',
  code: 'not_found',
  message: 'Not found.',
};

describe.each([
  ['POST /api/v1/tables/:id/rows', post],
  ['PATCH /api/v1/tables/:id/rows/:rowId', patch],
])('%s: the item check refuses with its exact body (pre-check removal)', (_name, send) => {
  it('a table the scope reads but may not change is 403 item-workspace, its exact body', async () => {
    const res = await answer(send, editCheckRefusalError('no_edit'));
    expect(res.status).toBe(403);
    expect(res.body).toEqual(ITEM_WORKSPACE);
  });

  it('a table the scope does not read is 404, its exact body', async () => {
    const res = await answer(send, editCheckRefusalError('no_read'));
    expect(res.status).toBe(404);
    expect(res.body).toEqual(NOT_FOUND);
  });
});

/** The copy's answer through the one mapper: the gate's words, readOnly. */
const COPY = {
  error: 'forbidden',
  reason: 'item-workspace',
  code: 'forbidden',
  message:
    'This is a read-only copy of an accepted item: nobody changes it. Its author may delete it.',
  readOnly: true,
};

describe.each([
  ['POST /api/v1/tables/:id/rows', post],
  ['PATCH /api/v1/tables/:id/rows/:rowId', patch],
])(
  '%s: the route reads the table in the scope and asks its edit before the tool (pre-check removal part 2)',
  (_name, send) => {
    // A handler that ran would answer the opaque 500: each refusal below
    // comes before it.
    const ran = new Error('the tool ran');

    it('a table the scope does not read (or none) is the 404 of none', async () => {
      h.title = null;
      const res = await answer(send, ran);
      expect(res.status).toBe(404);
      expect(res.text).toBe('{"error":"not found"}');
    });

    it('an edit check refusal of a table it reads (no_edit) is 403 item-workspace', async () => {
      h.right = 'no_edit';
      const res = await answer(send, ran);
      expect(res.status).toBe(403);
      expect(res.body).toEqual(ITEM_WORKSPACE);
    });

    it('a read-only copy is the copy’s 403, readOnly', async () => {
      h.right = 'copy';
      const res = await answer(send, ran);
      expect(res.status).toBe(403);
      expect(res.body).toEqual(COPY);
    });

    it('a no_read verdict is the mapper’s 404', async () => {
      h.right = 'no_read';
      const res = await answer(send, ran);
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    });
  },
);
