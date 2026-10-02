/**
 * The OWNER's app tool broker (client tier audit 2026-09-30, L1): an admin's
 * run of a CLIENT-level app keeps the client rules, because every client
 * reads that app's database; any other app keeps the owner's rules. The level rule (appToolLevel,
 * appToolScope) is the real one; the verdict records the level it was asked
 * at, and at client level and at none the REAL rules answer (they refuse
 * before any lookup). No database.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const APP = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  audience: 'admin',
  toolSlugs: ['contact_list'] as string[],
  levels: [] as string[],
  dispatched: [] as Array<{ level: string; ctx: Record<string, unknown> }>,
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: ANCHOR,
    email: 'jo@example.invalid',
    actor: { id: ACTOR, email: 'jo@example.invalid', displayName: 'Jo', isOwner: true },
  })),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppRuntime: vi.fn(async (_owner: string, id: string) =>
    id === APP ? { id, audience: h.audience, manifest: { toolSlugs: h.toolSlugs } } : null,
  ),
}));
vi.mock('@mantle/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/tools')>();
  const { currentViewerLevel } = await import('@mantle/db');
  return {
    ...real,
    appToolVerdict: vi.fn(
      async (level: string, owner: string, declared: string[], slug: string) => {
        h.levels.push(level);
        if (level === 'client' || level === 'none') {
          return real.appToolVerdict(level, owner, declared, slug);
        }
        if (!declared.includes(slug)) return { ok: false, status: 403, reason: 'not declared' };
        // node_share stands for any tool flagged "needs confirmation".
        return slug === 'node_share'
          ? {
              ok: true,
              tool: { slug, name: 'Share an item', description: 'Shares.', requiresConfirm: true },
            }
          : { ok: true, tool: { slug } };
      },
    ),
    dispatchTool: vi.fn(async (_tool: unknown, _input: unknown, ctx: Record<string, unknown>) => {
      h.dispatched.push({ level: currentViewerLevel(), ctx });
      return { ok: true, output: [] };
    }),
  };
});

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let broker: Handler;
const call = (slug: string, extra: Record<string, unknown> = {}) =>
  broker(
    new Request('http://x/api', { method: 'POST', body: JSON.stringify({ slug, ...extra }) }),
    { params: Promise.resolve({ id: APP }) },
  );

beforeAll(async () => {
  process.env.SESSION_SECRET ??= 'x'.repeat(48);
  broker = (await import('./[id]/tool-broker/route')).POST;
}, 60_000);

beforeEach(() => {
  h.audience = 'admin';
  h.toolSlugs = ['contact_list'];
  h.levels.length = 0;
  h.dispatched.length = 0;
});

describe('owner app tool broker: client rules on a client app, owner rules elsewhere', () => {
  it('an admin-level app runs a declared tool with the owner auth, as always', async () => {
    const res = await call('contact_list');
    expect(res.status).toBe(200);
    expect(h.levels).toEqual(['admin']);
    expect(h.dispatched[0]).toMatchObject({
      level: 'admin',
      ctx: { ownerId: ANCHOR, surface: { kind: 'web' } },
    });
  });

  it('a client-level app refuses contact_list and page_get for an admin too', async () => {
    h.audience = 'client';
    h.toolSlugs = ['contact_list', 'page_get'];
    for (const slug of h.toolSlugs) {
      const res = await call(slug);
      expect(res.status, slug).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/client apps/);
    }
    expect(h.levels).toEqual(['client', 'client']);
    expect(h.dispatched).toHaveLength(0);
  });

  it('a team or public app keeps the owner rules (team apps call MCP and recipe tools)', async () => {
    for (const audience of ['team', 'public']) {
      h.audience = audience;
      h.levels.length = 0;
      h.dispatched.length = 0;
      const res = await call('contact_list');
      expect(res.status, audience).toBe(200);
      expect(h.levels).toEqual(['admin']);
      expect(h.dispatched[0]).toMatchObject({
        level: 'admin',
        ctx: { ownerId: ANCHOR, surface: { kind: 'web' } },
      });
    }
  });
});

/**
 * Apps audit S1 (Jason, 2026-10-02: ask in the app). A tool that needs the
 * owner's confirmation never runs on the app's word: the first call answers
 * 409 with a ticket for that exact call, and only the host's second call
 * carrying it runs the tool.
 */
describe('owner app tool broker: a confirm-gated tool asks the owner first', () => {
  type ConfirmReply = { ok: false; reason: string; confirm: { token: string; slug: string } };

  it('answers 409 with a ticket, and runs nothing', async () => {
    h.toolSlugs = ['node_share'];
    const res = await call('node_share', { input: { id: 'n1' } });
    expect(res.status).toBe(409);
    const body = (await res.json()) as ConfirmReply;
    expect(body).toMatchObject({ ok: false, reason: 'confirm', confirm: { slug: 'node_share' } });
    expect(body.confirm.token).toEqual(expect.any(String));
    expect(h.dispatched).toHaveLength(0);
  });

  it('runs the call once the host sends the ticket back with the same input', async () => {
    h.toolSlugs = ['node_share'];
    const first = (await (
      await call('node_share', { input: { id: 'n1' } })
    ).json()) as ConfirmReply;
    const res = await call('node_share', {
      input: { id: 'n1' },
      confirmToken: first.confirm.token,
    });
    expect(res.status).toBe(200);
    expect(h.dispatched).toHaveLength(1);
  });

  it('refuses a ticket for another input, or a forged one', async () => {
    h.toolSlugs = ['node_share', 'contact_list'];
    const first = (await (
      await call('node_share', { input: { id: 'n1' } })
    ).json()) as ConfirmReply;
    const other = await call('node_share', {
      input: { id: 'n2' },
      confirmToken: first.confirm.token,
    });
    expect(other.status).toBe(403);
    const forged = await call('node_share', { input: { id: 'n1' }, confirmToken: 'abc.def' });
    expect(forged.status).toBe(403);
    expect(h.dispatched).toHaveLength(0);
    // A tool with no confirmation flag runs straight, as before.
    expect((await call('contact_list')).status).toBe(200);
  });
});
