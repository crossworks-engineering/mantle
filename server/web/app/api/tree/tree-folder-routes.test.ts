/**
 * The owner folder routes as HTTP (docs/folder-tree.md, "Writing"): what a
 * create and a restyle pass to the tree, and that a look the tree would not
 * store (a tint outside APP_TINTS, an icon that is neither an emoji nor
 * `lucide:<name>`) is a 400 before any write. The session and the tree are
 * stood in; the rules themselves are proven on Postgres in
 * packages/content/src/tree/tree.db.test.ts and tree-kinds.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '00000000-0000-4000-8000-000000000001';
const FOLDER = '00000000-0000-4000-8000-0000000000f0';

const h = vi.hoisted(() => ({ calls: [] as Array<{ fn: string; args: unknown[] }> }));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: OWNER,
    actor: { id: '00000000-0000-4000-8000-000000000002', displayName: 'Admin' },
  })),
}));

vi.mock('@/lib/tree-route', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureTreeRoot: async () => undefined,
}));

vi.mock('@mantle/content/tree', async (importOriginal) => {
  const record =
    (fn: string, answer: unknown) =>
    async (...args: unknown[]) => {
      h.calls.push({ fn, args });
      return answer;
    };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    createTreeFolder: record('create', { id: FOLDER, name: 'Clients' }),
    updateTreeFolder: record('update', { id: FOLDER, name: 'Clients' }),
    notifyTreeChanged: record('notify', undefined),
  };
});

type Params = { kind: string; id?: string };
type Handler = (r: Request, c: { params: Promise<Params> }) => Promise<Response>;

const send = (handler: Handler, method: string, url: string, params: Params, body: unknown) =>
  handler(
    new Request(`http://brain.example${url}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );

beforeEach(() => {
  h.calls.length = 0;
});

describe('POST /api/tree/:kind/folders', () => {
  const url = '/api/tree/notes/folders';
  const params = { kind: 'notes' };
  const post = async (body: unknown) =>
    send((await import('./[kind]/folders/route')).POST as Handler, 'POST', url, params, body);

  it('creates a plain folder as before', async () => {
    const res = await post({ parentId: null, name: 'Clients' });
    expect(res.status).toBe(201);
    expect(h.calls.map((c) => c.fn)).toEqual(['create', 'notify']);
    expect(h.calls[0]!.args).toEqual([OWNER, 'notes', { parentId: null, name: 'Clients' }]);
  });

  it('passes the icon and colour into the one create', async () => {
    const res = await post({
      parentId: null,
      name: 'Clients',
      icon: 'lucide:briefcase',
      color: 'cyan',
    });
    expect(res.status).toBe(201);
    expect(h.calls[0]!.args[2]).toEqual({
      parentId: null,
      name: 'Clients',
      icon: 'lucide:briefcase',
      color: 'cyan',
    });
    h.calls.length = 0;
    expect((await post({ parentId: null, name: 'Fun', icon: '🎉', color: null })).status).toBe(201);
    expect(h.calls[0]!.args[2]).toEqual({ parentId: null, name: 'Fun', icon: '🎉', color: null });
    // An empty icon (older callers) is none, as null is.
    h.calls.length = 0;
    expect((await post({ parentId: null, name: 'Plain', icon: '' })).status).toBe(201);
    expect(h.calls[0]!.args[2]).toEqual({ parentId: null, name: 'Plain', icon: null });
  });

  it('refuses a tint outside APP_TINTS and an icon of the wrong shape, writing nothing', async () => {
    for (const body of [
      { parentId: null, name: 'A', color: 'magenta' },
      { parentId: null, name: 'A', color: 'Cyan' },
      { parentId: null, name: 'A', icon: 'briefcase' },
      { parentId: null, name: 'A', icon: 'lucide:Not A Name' },
      { parentId: null, name: 'A', icon: 'lucide:' },
      { parentId: null, name: 'A', icon: 'x'.repeat(49) },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(h.calls).toEqual([]);
  });
});

describe('PATCH /api/tree/:kind/folders/:id', () => {
  const url = `/api/tree/notes/folders/${FOLDER}`;
  const params = { kind: 'notes', id: FOLDER };
  const patch = async (body: unknown) =>
    send(
      (await import('./[kind]/folders/[id]/route')).PATCH as Handler,
      'PATCH',
      url,
      params,
      body,
    );

  it('takes the same look values as the create, and null to clear', async () => {
    expect((await patch({ icon: 'lucide:briefcase', color: 'cyan' })).status).toBe(200);
    expect(h.calls[0]!.args).toEqual([
      OWNER,
      'notes',
      FOLDER,
      { icon: 'lucide:briefcase', color: 'cyan' },
      { confirm: undefined, seen: undefined },
    ]);
    h.calls.length = 0;
    expect((await patch({ icon: null, color: null })).status).toBe(200);
    expect(h.calls[0]!.args[3]).toEqual({ icon: null, color: null });
    // '' cleared the icon before the shape check; it still does.
    h.calls.length = 0;
    expect((await patch({ icon: '' })).status).toBe(200);
    expect(h.calls[0]!.args[3]).toEqual({ icon: null });
  });

  it('refuses the same bad looks as the create', async () => {
    expect((await patch({ color: 'magenta' })).status).toBe(400);
    expect((await patch({ icon: 'briefcase' })).status).toBe(400);
    expect(h.calls).toEqual([]);
  });
});
