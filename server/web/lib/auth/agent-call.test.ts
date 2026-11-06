/**
 * The brain's refusal of an agent-driven risky write (docs/agent-ui.md, "The
 * brain refuses, the window holds"): a non-GET carrying `x-mantle-agent-call`
 * (a call uuid or `lesson:<uuid>`, any value) is 403
 * `{ error: 'agent_refused', reason }` when its route deletes, sends, shares,
 * publishes, moves in the tree or changes a setting, is Admin-only or
 * declared a read, or its body has a sharing field, whatever the client did.
 * Read against every row the route declarations give (the pinned snapshot,
 * __snapshots__/route-policy.rows.json), so a new route is judged the day it
 * lands.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_CALL_HEADER } from '@mantle/client-types/agent-ui';
import {
  AGENT_OPEN_EXACT,
  AGENT_REFUSED_EXACT,
  AGENT_REFUSED_PREFIXES,
  agentRefusesRow,
  hasSharingField,
  refuseAgentCall,
} from './agent-call';

type Snap = Record<string, { effect: 'read' | 'write'; area?: string | null; open?: string }>;
const ROWS = Object.entries(
  JSON.parse(
    readFileSync(new URL('./__snapshots__/route-policy.rows.json', import.meta.url), 'utf8'),
  ) as Snap,
).map(([key, r]) => {
  const [method, pattern] = key.split(' ', 2) as [string, string];
  return {
    method,
    pattern,
    area: (r.area ?? null) as never,
    effect: r.effect,
    // The snapshot writes `open` only when it is not Admin-only.
    open: (r.open ?? 'admin') as 'admin' | 'login',
  };
});
const row = (key: string) => {
  const found = ROWS.find((r) => `${r.method} ${r.pattern}` === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
};

const CALL = '33333333-3333-4333-8333-333333333333';
const LESSON = 'lesson:44444444-4444-4444-8444-444444444444';

const req = (
  method: string,
  tag: string | null = CALL,
  body?: unknown,
  type = 'application/json',
) =>
  new Request('http://brain.invalid/x', {
    method,
    headers: {
      ...(tag !== null ? { [AGENT_CALL_HEADER]: tag } : {}),
      ...(body !== undefined ? { 'content-type': type } : {}),
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });

/** The refusal's body, or null when let through. */
async function refused(key: string, tag: string | null = CALL, body?: unknown, type?: string) {
  const r = row(key);
  const res = await refuseAgentCall(r, req(r.method, tag, body, type));
  if (!res) return null;
  expect(res.status, key).toBe(403);
  return (await res.json()) as { error: string; reason: string };
}

describe('refuseAgentCall', () => {
  it('refuses a risky write that carries the header, 403 agent_refused with its reason', async () => {
    expect(await refused('POST /api/shares')).toEqual({
      error: 'agent_refused',
      reason: 'admin_only',
    });
    expect(await refused('POST /api/messenger/c/:id/messages')).toEqual({
      error: 'agent_refused',
      reason: 'listed',
    });
  });

  it('any header value counts as tagged: a call uuid, a lesson, anything', async () => {
    for (const tag of [CALL, LESSON, 'lesson:', 'x', '']) {
      expect((await refused('POST /api/messenger/c/:id/messages', tag))?.error, tag).toBe(
        'agent_refused',
      );
    }
  });

  it('lets the same write through without the header (the person allowed it)', async () => {
    expect(await refused('POST /api/shares', null)).toBeNull();
    expect(await refused('POST /api/messenger/c/:id/messages', null)).toBeNull();
  });

  it('never refuses a read, with the header or not', async () => {
    for (const r of ROWS.filter((x) => x.method === 'GET' || x.method === 'HEAD')) {
      expect(await refuseAgentCall(r, req(r.method)), `${r.method} ${r.pattern}`).toBeNull();
    }
  });

  it('lets an ordinary content write through (an agent may edit what the person may)', async () => {
    for (const key of [
      'PATCH /api/pages/:id',
      'POST /api/notes',
      'PATCH /api/tasks/:id',
      'POST /api/messenger/c/:id/read',
    ]) {
      expect(await refused(key, CALL, { title: 'Plan', body: 'the public road' }), key).toBeNull();
      expect(agentRefusesRow(row(key)), key).toBeNull();
    }
  });

  it('refuses every DELETE, every Admin-area write and every Admin-only write', () => {
    const risky = ROWS.filter(
      (r) =>
        r.method !== 'GET' &&
        r.method !== 'HEAD' &&
        (r.method === 'DELETE' || r.area !== null || r.open === 'admin'),
    );
    expect(risky.length).toBeGreaterThan(100);
    for (const r of risky) expect(agentRefusesRow(r), `${r.method} ${r.pattern}`).not.toBeNull();
    expect(agentRefusesRow(row('DELETE /api/notes/:id'))).toBe('delete');
    expect(agentRefusesRow(row('DELETE /api/agents/:id'))).toBe('delete');
    expect(agentRefusesRow(row('POST /api/ai-workers'))).toBe('settings');
    expect(agentRefusesRow(row('POST /api/journal'))).toBe('admin_only');
  });

  it('an Admin-only write: refused tagged (a call or a lesson), let through untagged', async () => {
    for (const tag of [CALL, LESSON]) {
      expect(await refused('POST /api/contacts', tag, { name: 'Pat' }), tag).toEqual({
        error: 'agent_refused',
        reason: 'admin_only',
      });
    }
    expect(await refused('POST /api/contacts', null, { name: 'Pat' })).toBeNull();
  });

  it('a tree move: refused tagged, let through untagged', async () => {
    for (const key of ['POST /api/tree/:kind/move', 'POST /api/pages/:id/move']) {
      expect(await refused(key, CALL, { to: 'f1' }), key).toEqual({
        error: 'agent_refused',
        reason: 'tree_move',
      });
      expect(await refused(key, LESSON, { to: 'f1' }), key).not.toBeNull();
      expect(await refused(key, null, { to: 'f1' }), key).toBeNull();
    }
  });

  it('a share or visibility field in the body, at any depth: refused tagged, let through untagged', async () => {
    const bodies: unknown[] = [
      { visibility: 'workspace' },
      { title: 'x', meta: { share: { with: 'ws-1' } } },
      { items: [{ id: 'a' }, { id: 'b', settings: { Published: true } }] },
      { is_public: true },
      { isPublic: true },
      { access: 'everyone' },
      { members: ['l1'] },
      { owner: 'l2' },
      [{ deep: [[{ sharing: 'on' }]] }],
    ];
    for (const key of ['PATCH /api/tree/:kind/folders/:id', 'PATCH /api/pages/:id']) {
      for (const b of bodies) {
        expect(await refused(key, CALL, b), `${key} ${JSON.stringify(b)}`).toEqual({
          error: 'agent_refused',
          reason: 'sharing_field',
        });
        expect(await refused(key, LESSON, b), JSON.stringify(b)).not.toBeNull();
        expect(await refused(key, null, b), JSON.stringify(b)).toBeNull();
      }
    }
  });

  it('the body is read whatever its content type says, a form too', async () => {
    const key = 'PATCH /api/pages/:id';
    expect((await refused(key, CALL, { visibility: 'x' }, 'text/plain'))?.reason).toBe(
      'sharing_field',
    );
    expect(
      (await refused(key, CALL, 'title=a&visibility=b', 'application/x-www-form-urlencoded'))
        ?.reason,
    ).toBe('sharing_field');
    expect(await refused(key, CALL, 'title=a', 'application/x-www-form-urlencoded')).toBeNull();
    // Not JSON: the route answers it as it would.
    expect(await refused(key, CALL, 'not json', 'application/json')).toBeNull();
  });

  it('a body too large to check is held', async () => {
    const big = JSON.stringify({ text: 'a'.repeat(8 * 1024 * 1024 + 1) });
    expect((await refused('PATCH /api/pages/:id', CALL, big))?.reason).toBe('body_unchecked');
    expect(await refused('PATCH /api/pages/:id', null, big)).toBeNull();
  });

  it('a non-GET on a route declared a read is refused (no early return for those)', async () => {
    const reads = ROWS.filter(
      (r) => r.effect === 'read' && r.method !== 'GET' && r.method !== 'HEAD',
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(agentRefusesRow(r), `${r.method} ${r.pattern}`).not.toBeNull();
    }
    expect(agentRefusesRow(row('POST /api/formulas/:id/evaluate'))).toBe('declared_read');
  });

  it('refuses the sends, shares, publishes and personal settings by name', () => {
    for (const key of [
      'POST /api/shares',
      'PATCH /api/shares/:id',
      'POST /api/grants/:nodeId',
      'POST /api/contacts/:id/sharing',
      'POST /api/apps/:id/publish',
      'POST /api/messenger/c/:id/messages',
      'POST /api/messenger/conversations',
      'POST /api/messenger/c/:id/call',
      'POST /api/messenger/c/:id/history/delete',
      // Audit round (members): a chat's PATCH and typing.
      'PATCH /api/messenger/c/:id',
      'POST /api/messenger/c/:id/typing',
      'PUT /api/profile/agent-ui',
      'PUT /api/profile/sounds',
      'POST /api/auth/change-password',
      'POST /api/access-keys',
      'POST /api/workspaces/:id/users',
      'POST /api/telegram/pair',
      'PATCH /api/recall/maps/:id',
      'POST /api/entities/merge',
      'POST /api/apps/:id/tool-broker',
      'POST /api/assistant/turn',
      'POST /api/assistant/threads/:id/continue',
      'POST /api/recall/revisions/:id/restore',
    ]) {
      expect(agentRefusesRow(row(key)), key).not.toBeNull();
    }
  });

  it("a chat's PATCH is refused as itself only: marking the chat read stays open", async () => {
    expect(await refused('PATCH /api/messenger/c/:id')).not.toBeNull();
    expect(await refused('POST /api/messenger/c/:id/typing')).not.toBeNull();
    expect(agentRefusesRow(row('POST /api/messenger/c/:id/read'))).toBeNull();
    expect(await refused('GET /api/messenger/c/:id')).toBeNull();
  });

  it("leaves the window's own answer and a turn's cancel open, whatever their body holds", async () => {
    for (const key of AGENT_OPEN_EXACT.map((p) => `POST ${p}`)) {
      expect(agentRefusesRow(row(key)), key).toBeNull();
      expect(
        await refused(key, CALL, { result: { ok: true, access: 'x', owner: 'y' } }),
        key,
      ).toBeNull();
    }
  });

  it('every exact route exists', () => {
    for (const p of [...AGENT_REFUSED_EXACT, ...AGENT_OPEN_EXACT]) {
      expect(
        ROWS.some((r) => r.pattern === p),
        p,
      ).toBe(true);
    }
  });

  it('every listed prefix names a route that exists', () => {
    for (const p of AGENT_REFUSED_PREFIXES) {
      expect(
        ROWS.some((r) => r.pattern === p || r.pattern.startsWith(`${p}/`)),
        p,
      ).toBe(true);
    }
  });
});

describe('hasSharingField', () => {
  it('matches keys, never values', () => {
    expect(hasSharingField({ title: 'public', text: 'share it' })).toBe(false);
    expect(hasSharingField(['owner', 'access'])).toBe(false);
    expect(hasSharingField({ Owner: 1 })).toBe(true);
    expect(hasSharingField({ 'share-mode': 1 })).toBe(false);
    expect(hasSharingField(null)).toBe(false);
    expect(hasSharingField('visibility')).toBe(false);
  });
});
