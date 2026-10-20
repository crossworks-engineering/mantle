/**
 * The OWNER's app tool broker (client tier audit 2026-09-30, L1; workspaces
 * W5b2, plan R2): an admin's run of an app a workspace other than Admin
 * holds keeps the team rules, because the app reads only what every holder
 * reads; an app Admin alone holds keeps the owner's rules. The rule
 * (appToolLevel, appToolScope) is the real one; the verdict records the
 * rules it was asked at, and the dispatch records whether it ran as system
 * work or inside withViewer for the app's scope (W8c). No database.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** The owner row's Login (ownerLoginCaller, plan v3.2 section 2.2), stood
 *  in from the owner answer the test describes; adminFacts (mocked below)
 *  answers its kind. */
function asOwnerLogin(owner: () => unknown): () => unknown {
  return () => {
    const o = owner() as {
      kind: string;
      user: { id: string; email: string; actor: { id: string; displayName?: string | null } };
      member: {
        loginId: string;
        anchorId: string;
        email: string;
        displayName: string | null;
      } | null;
    };
    const m = o.member;
    return {
      loginId: m ? m.loginId : o.user.actor.id,
      brainId: m ? m.anchorId : o.user.id,
      email: m ? m.email : o.user.email,
      displayName: m ? m.displayName : (o.user.actor.displayName ?? null),
      contactId: null,
      source: 'web',
      sessionEpoch: 0,
      actor: m
        ? { id: m.loginId, email: m.email, displayName: m.displayName, isOwner: false }
        : o.user.actor,
      standInAdmin: o.kind === 'admin',
    };
  };
}
vi.mock('@/lib/auth/login', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  adminFacts: vi.fn(async (l: { standInAdmin?: boolean }) => ({
    admin: l.standInAdmin === true,
    areas: new Set(),
  })),
}));

const ANCHOR = '33333333-3333-4333-8333-333333333333';
const ACTOR = '55555555-5555-4555-8555-555555555555';
const APP = '77777777-7777-4777-8777-777777777777';

const h = vi.hoisted(() => ({
  // What the app's holders allow (AppRuntime.toolRules).
  toolRules: 'admin' as 'admin' | 'team',
  toolSlugs: ['contact_list'] as string[],
  levels: [] as string[],
  // 'system' when the dispatch ran as is, else the actsFor withViewer had.
  dispatched: [] as Array<{ ranAs: unknown; ctx: Record<string, unknown> }>,
  viewers: [] as unknown[],
  current: null as unknown,
}));

// No database: the workspace scope withViewer enters is read on Postgres
// (proven in packages/db/src/viewer-shim.db.test.ts). Here it records who the
// broker acts for, and marks the dispatch it wraps as run in that scope.
vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  return {
    ...real,
    withViewer: vi.fn(async (actsFor: unknown, fn: () => Promise<unknown>) => {
      h.viewers.push(actsFor);
      const outer = h.current;
      h.current = actsFor;
      try {
        return await fn();
      } finally {
        h.current = outer;
      }
    }),
  };
});

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOwnerOr401: vi.fn(async () => ({
    id: ANCHOR,
    email: 'jo@example.invalid',
    actor: { id: ACTOR, email: 'jo@example.invalid', displayName: 'Jo', isOwner: true },
  })),
  // The owner runner routes take every login since W7e: here an Admin user.
  // The broker reads the caller the pipeline answers (A4 step 3b part 3).
  ownerLoginCaller: asOwnerLogin(
    vi.fn(() => ({
      kind: 'admin',
      user: {
        id: ANCHOR,
        email: 'jo@example.invalid',
        actor: { id: ACTOR, email: 'jo@example.invalid', displayName: 'Jo', isOwner: true },
      },
      source: 'web',
      member: null,
    })),
  ),
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAppRuntime: vi.fn(async (_owner: string, id: string) =>
    id === APP
      ? {
          id,
          toolRules: h.toolRules,
          manifest: { toolSlugs: h.toolSlugs },
        }
      : null,
  ),
}));
vi.mock('@mantle/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/tools')>();
  return {
    ...real,
    appToolVerdict: vi.fn(
      async (level: string, owner: string, declared: string[], slug: string) => {
        h.levels.push(level);
        if (level === 'none') {
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
      h.dispatched.push({ ranAs: h.current ?? 'system', ctx });
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
  h.toolRules = 'admin';
  h.toolSlugs = ['contact_list'];
  h.levels.length = 0;
  h.dispatched.length = 0;
  h.viewers.length = 0;
  h.current = null;
});

describe('owner app tool broker: team rules when another workspace holds the app', () => {
  it('an app Admin alone holds runs a declared tool with the owner auth, as always', async () => {
    const res = await call('contact_list');
    expect(res.status).toBe(200);
    expect(h.levels).toEqual(['admin']);
    // System work: no workspace scope is entered.
    expect(h.viewers).toEqual([]);
    expect(h.dispatched[0]).toMatchObject({
      ranAs: 'system',
      ctx: { ownerId: ANCHOR, surface: { kind: 'web' } },
    });
  });

  it('an app another workspace holds runs the team rules for an admin too (R2)', async () => {
    h.toolRules = 'team';
    const res = await call('contact_list');
    expect(res.status).toBe(200);
    expect(h.levels).toEqual(['team']);
    // The dispatch runs inside the app's scope for the acting login.
    expect(h.viewers).toEqual([{ login: ACTOR, app: { id: APP } }]);
    expect(h.dispatched[0]).toMatchObject({
      ranAs: { login: ACTOR, app: { id: APP } },
      ctx: {
        ownerId: ANCHOR,
        surface: { kind: 'team', loginId: ACTOR, contactName: 'Jo', privateReads: false },
      },
    });
  });

  it('an undeclared tool is refused, whoever holds the app', async () => {
    for (const rules of ['admin', 'team'] as const) {
      h.toolRules = rules;
      const res = await call('page_get');
      expect(res.status, rules).toBe(403);
    }
    expect(h.dispatched).toHaveLength(0);
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
    // The ticket is spent: the same call again needs a new one (audit, low).
    const again = await call('node_share', {
      input: { id: 'n1' },
      confirmToken: first.confirm.token,
    });
    expect(again.status).toBe(403);
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
