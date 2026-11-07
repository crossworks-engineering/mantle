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
  checkAgentCall,
  hasSharingField,
  refuseAgentCall,
} from './agent-call';
import { AGENT_ALLOWED_WRITES } from './agent-call.allowed';

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
const LESSON_TAG = LESSON;

const req = (
  method: string,
  tag: string | null = CALL,
  body?: unknown,
  type = 'application/json',
  url = 'http://brain.invalid/x',
) =>
  new Request(url, {
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

describe('copies, moves and workspace targets count as sharing', () => {
  const at = async (key: string, url: string, tag: string | null = CALL, body?: unknown) => {
    const r = row(key);
    const res = await refuseAgentCall(r, req(r.method, tag, body, 'application/json', url));
    return res ? ((await res.json()) as { reason: string }).reason : null;
  };

  it('a write whose query names its workspace (`ws`): workspace_target; untagged it passes', async () => {
    const url = 'http://brain.invalid/api/notes?ws=55555555-5555-4555-8555-555555555555';
    expect(await at('POST /api/notes', url, CALL, { title: 'x' })).toBe('workspace_target');
    expect(await at('POST /api/notes', url, LESSON, { title: 'x' })).toBe('workspace_target');
    expect(await at('POST /api/notes', url, null, { title: 'x' })).toBeNull();
    expect(
      await at('POST /api/notes', 'http://brain.invalid/api/notes', CALL, { title: 'x' }),
    ).toBeNull();
  });

  it('a move or copy field in the body, any depth and spelling: move', async () => {
    for (const b of [
      { move: true },
      { copy_to: 'f1' },
      { parentId: 'f1' },
      { parent_id: 'f1' },
      { item: { folderId: 'f1' } },
      [{ folder_id: 'f1' }],
    ]) {
      expect(await refused('PATCH /api/pages/:id', CALL, b), JSON.stringify(b)).toEqual({
        error: 'agent_refused',
        reason: 'move',
      });
      expect(await refused('PATCH /api/pages/:id', null, b), JSON.stringify(b)).toBeNull();
    }
  });

  it('a duplicate or copy route: copy; a commit: publish; the journal and contacts: admin_only', async () => {
    expect(agentRefusesRow(row('POST /api/apps/:id/duplicate'))).toBe('copy');
    for (const key of [
      'POST /api/pages/:id/commit',
      'POST /api/tables/:id/commit',
      'POST /api/draws/:id/commit',
      'POST /api/v1/tables/:id/commit',
    ]) {
      expect(agentRefusesRow(row(key)), key).toBe('publish');
    }
    for (const key of [
      'POST /api/journal',
      'PATCH /api/journal/:id',
      'POST /api/journal/:id/resolve',
      'POST /api/v1/journal',
      'POST /api/contacts',
      'PATCH /api/contacts/:id',
    ]) {
      expect(agentRefusesRow(row(key)), key).toBe('admin_only');
    }
    expect(await refused('POST /api/pages/:id/commit', null)).toBeNull();
  });
});

describe('checkAgentCall hands the body on', () => {
  it('a tagged write it lets through comes back rebuilt, its body whole', async () => {
    const r = row('PATCH /api/pages/:id');
    const body = { title: 'Plan', text: 'x'.repeat(10_000) };
    const out = await checkAgentCall(r, req('PATCH', CALL, body));
    expect(out && 'req' in out).toBe(true);
    const handed = (out as { req: Request }).req;
    expect(await handed.json()).toEqual(body);
    expect(handed.method).toBe('PATCH');
    expect(handed.headers.get(AGENT_CALL_HEADER)).toBe(CALL);
  });

  it('nothing to hand on: untagged, a read; a tagged multipart body is refused', async () => {
    const r = row('PATCH /api/pages/:id');
    expect(await checkAgentCall(r, req('PATCH', null, { title: 'x' }))).toBeNull();
    expect(await checkAgentCall(row('GET /api/pages/:id'), req('GET'))).toBeNull();
    const form = new FormData();
    form.set('title', 'x');
    const multipart = new Request('http://brain.invalid/x', {
      method: 'PATCH',
      headers: { [AGENT_CALL_HEADER]: CALL },
      body: form,
    });
    const out = await checkAgentCall(r, multipart);
    expect(out && 'refused' in out && out.refused.status).toBe(403);
  });
});

describe('every non-GET row is refused or reviewed (agent-call.allowed.ts)', () => {
  const writes = ROWS.filter(
    (r) => r.method !== 'GET' && r.method !== 'HEAD' && r.method !== 'OPTIONS',
  );

  it('a row agentRefusesRow lets through is on the reviewed list, with why', () => {
    const unreviewed = writes
      .filter((r) => agentRefusesRow(r) === null)
      .map((r) => `${r.method} ${r.pattern}`)
      .filter((k) => !Object.hasOwn(AGENT_ALLOWED_WRITES, k));
    expect(unreviewed).toEqual([]);
    for (const [k, why] of Object.entries(AGENT_ALLOWED_WRITES)) {
      expect(why.trim().length, k).toBeGreaterThan(10);
    }
  });

  it('the list names only rows that exist and that agentRefusesRow does not refuse', () => {
    for (const k of Object.keys(AGENT_ALLOWED_WRITES)) {
      const r = writes.find((x) => `${x.method} ${x.pattern}` === k);
      expect(r, `${k}: no such non-GET row`).toBeDefined();
      expect(agentRefusesRow(r!), `${k}: refused already, take it off the list`).toBeNull();
    }
    expect(Object.keys(AGENT_ALLOWED_WRITES)).toHaveLength(44);
  });

  it('no listed row needs a field the body rules refuse (it could never pass)', () => {
    // Cheap and textual: the route file's zod body, a field the move,
    // sharing or approval rules refuse, declared without .optional().
    const REFUSED =
      /\b(parentPath|parentId|parent_id|folderId|folder_id|parent|move|copy_to|visibility|share|confirm|seen)\s*:\s*z\.[^\n]*/g;
    const dead: string[] = [];
    // Creates only: an edit route's body is often a union of variants, one
    // of which carries the refused field while the others do not.
    for (const key of Object.keys(AGENT_ALLOWED_WRITES).filter((k) => k.startsWith('POST '))) {
      const [, pattern] = key.split(' ', 2) as [string, string];
      const file = new URL(
        `../../app${pattern.replace(/:([A-Za-z0-9_]+)/g, '[$1]')}/route.ts`,
        import.meta.url,
      );
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue; // an alias route re-exports its handler
      }
      for (const m of text.matchAll(REFUSED)) {
        if (!/\.optional\(\)|\.default\(/.test(m[0])) dead.push(`${key}: ${m[1]}`);
      }
    }
    expect(dead).toEqual([]);
  });

  it('a create that needs a parent (a move field) is refused by its row, before its body', () => {
    for (const key of [
      'POST /api/files/files',
      'POST /api/files/folders',
      'POST /api/tree/:kind/folders',
      'POST /api/v1/files',
    ]) {
      expect(agentRefusesRow(row(key)), key).toBe('move');
    }
  });

  it('the reviewed round refuses the discards, the paid calls and a new chat thread', () => {
    for (const key of [
      'POST /api/pages/:id/discard-draft',
      'POST /api/tables/:id/discard-draft',
      'POST /api/draws/:id/discard-draft',
    ]) {
      expect(agentRefusesRow(row(key)), key).toBe('delete');
    }
    for (const key of [
      'POST /api/assistant/threads',
      'POST /api/assistant/threads/:id/summarize',
      'POST /api/assistant/transcribe',
      'POST /api/tables/import',
    ]) {
      expect(agentRefusesRow(row(key)), key).toBe('listed');
    }
  });
});

describe("an app's Admin settings are refused by field", () => {
  it('PATCH /api/apps/:id with mcpAccess, dataReadOnly or trustTools: admin_only; a rename passes', async () => {
    for (const b of [
      { mcpAccess: true },
      { dataReadOnly: false },
      { name: 'x', trustTools: true },
    ]) {
      expect(await refused('PATCH /api/apps/:id', CALL, b), JSON.stringify(b)).toEqual({
        error: 'agent_refused',
        reason: 'admin_only',
      });
      expect(await refused('PATCH /api/apps/:id', null, b)).toBeNull();
    }
    expect(await refused('PATCH /api/apps/:id', CALL, { name: 'Renamed' })).toBeNull();
    // The same field on another route is content.
    expect(await refused('PATCH /api/pages/:id', CALL, { trustTools: true })).toBeNull();
  });
});

describe("the body read keeps to the route's own ceiling", () => {
  it('a /s/ route reads no more than its 1 MB ceiling', async () => {
    const body = JSON.stringify({ text: 'a'.repeat(1024 * 1024 + 10) });
    const r = {
      method: 'POST',
      pattern: '/s/:token/db-broker',
      area: null,
      effect: 'write' as const,
      open: 'login' as const,
    };
    const res = await refuseAgentCall(
      r,
      req('POST', CALL, body, 'application/json', 'http://brain.invalid/s/tok/db-broker'),
    );
    expect(((await res!.json()) as { reason: string }).reason).toBe('body_unchecked');
    // Under the ceiling: read and let through.
    const small = await checkAgentCall(
      r,
      req('POST', CALL, { q: 1 }, 'application/json', 'http://brain.invalid/s/tok/db-broker'),
    );
    expect(small && 'req' in small).toBe(true);
  });
});

describe('the content type never hides a field', () => {
  const formReq = (url: string, method: string, body: BodyInit, type?: string, tag = CALL) =>
    new Request(url, {
      method,
      headers: { [AGENT_CALL_HEADER]: tag, ...(type ? { 'content-type': type } : {}) },
      body,
    });

  it('a tagged PATCH /api/pages/:id with a form content type and a JSON body is checked as JSON', async () => {
    const r = row('PATCH /api/pages/:id');
    for (const type of [
      'application/x-www-form-urlencoded',
      'text/plain',
      'application/octet-stream',
      undefined,
    ]) {
      const res = await refuseAgentCall(
        r,
        formReq('http://brain.invalid/api/pages/p1', 'PATCH', '{"visibility":"public"}', type),
      );
      expect(res?.status, String(type)).toBe(403);
      expect(await res!.json()).toEqual({ error: 'agent_refused', reason: 'sharing_field' });
    }
    // A byte order mark in front changes nothing.
    const bom = await refuseAgentCall(
      r,
      formReq('http://brain.invalid/api/pages/p1', 'PATCH', '﻿{"visibility":"x"}', 'text/plain'),
    );
    expect(bom?.status).toBe(403);
  });

  it('a form field that holds JSON is read too', async () => {
    const res = await refuseAgentCall(
      row('PATCH /api/pages/:id'),
      formReq(
        'http://brain.invalid/api/pages/p1',
        'PATCH',
        'patch=' + encodeURIComponent('{"meta":{"visibility":"public"}}'),
        'application/x-www-form-urlencoded',
      ),
    );
    expect(((await res!.json()) as { reason: string }).reason).toBe('sharing_field');
  });
});

describe('move, approval and route fields', () => {
  it('parentPath and parent move; confirm and seen approve a shared write', async () => {
    for (const [key, body, reason] of [
      [
        'POST /api/files/files',
        { parentPath: 'files.x', filename: 'a.md', content: 'x', confirm: true },
        'move',
      ],
      // A Files folder create is refused by its row (it needs a parent).
      ['POST /api/files/folders', { parentPath: 'files.x', name: 'F', confirm: true }, 'move'],
      ['PATCH /api/pages/:id', { title: 'F', confirm: true }, 'sharing_field'],
      ['PATCH /api/pages/:id', { parent: 'p2' }, 'move'],
      ['PATCH /api/pages/:id', { title: 'x', seen: 3 }, 'sharing_field'],
    ] as const) {
      expect(await refused(key, CALL, body), `${key} ${JSON.stringify(body)}`).toEqual({
        error: 'agent_refused',
        reason,
      });
      expect(await refused(key, null, body)).toBeNull();
    }
  });

  it("a canvas's source and an indexing change are refused by field", async () => {
    expect((await refused('PATCH /api/presents/:id', CALL, { source: '<div/>' }))?.reason).toBe(
      'publish',
    );
    expect(await refused('PATCH /api/presents/:id', CALL, { title: 'x' })).toBeNull();
    for (const key of ['PATCH /api/files/folders/:id', 'PATCH /api/files/files/:id']) {
      expect((await refused(key, CALL, { indexing: 'full' }))?.reason, key).toBe('settings');
    }
    // An upload is refused by its row (it needs a parent), its replace
    // with it.
    expect((await refused('POST /api/files/files', CALL, { replace: true }))?.reason).toBe('move');
    // A note's content edit stays allowed (the window holds a replace).
    expect(await refused('PATCH /api/notes/:id', CALL, { content: 'more text' })).toBeNull();
  });

  it("a folder's custom order is refused (the order is everyone's)", () => {
    expect(agentRefusesRow(row('POST /api/tree/:kind/place'))).toBe('listed');
  });
});

describe('a tagged multipart body and the value rules', () => {
  it('a tagged multipart body is refused before any byte of it is read', async () => {
    let pulls = 0;
    // No byte is pulled until someone reads (high water mark 0).
    const body = () =>
      new ReadableStream<Uint8Array>(
        {
          pull(ctrl) {
            pulls += 1;
            ctrl.enqueue(new TextEncoder().encode('--b\r\n'));
            ctrl.close();
          },
        },
        { highWaterMark: 0 },
      );
    // Any content type that holds `multipart/`, as the upload route reads
    // it (`includes`), whatever comes before it or its case.
    const types = [
      'multipart/form-data; boundary=b',
      'Multipart/Form-Data; boundary=b',
      'text/plain; multipart/form-data; boundary=b',
      'multipart/mixed; boundary=b',
    ];
    for (const key of ['POST /api/notes', 'PATCH /api/pages/:id']) {
      for (const type of types) {
        const r = row(key);
        const res = await refuseAgentCall(
          r,
          new Request('http://brain.invalid/x', {
            method: r.method,
            headers: { [AGENT_CALL_HEADER]: CALL, 'content-type': type },
            body: body(),
            duplex: 'half',
          } as RequestInit),
        );
        expect(((await res!.json()) as { reason: string }).reason, `${key} ${type}`).toBe(
          'body_unchecked',
        );
      }
    }
    expect(pulls).toBe(0);
  });

  it("a folder's place among its siblings (after) is refused, a rename passes", async () => {
    expect(
      (await refused('PATCH /api/tree/:kind/folders/:id', CALL, { after: null }))?.reason,
    ).toBe('listed');
    expect(await refused('PATCH /api/tree/:kind/folders/:id', CALL, { name: 'x' })).toBeNull();
  });

  it('a new canvas with a source is refused, without one it passes', async () => {
    expect(
      (await refused('POST /api/presents', CALL, { title: 'c', source: '<b/>' }))?.reason,
    ).toBe('publish');
    expect(await refused('POST /api/presents', CALL, { title: 'c' })).toBeNull();
  });

  it('a Stop that supersedes is refused; a plain Stop passes, its body unread', async () => {
    expect(
      (
        await refused('POST /api/assistant/turn/:turnId/cancel', CALL, {
          supersede: { newTurnId: 'k' },
        })
      )?.reason,
    ).toBe('delete');
    expect(await refused('POST /api/assistant/turn/:turnId/cancel', CALL)).toBeNull();
    expect(await refused('POST /api/assistant/turn/:turnId/cancel', CALL, {})).toBeNull();
    expect(
      await refused('POST /api/assistant/turn/:turnId/cancel', null, {
        supersede: { newTurnId: 'k' },
      }),
    ).toBeNull();
    // The window's answer stays open whatever it holds.
    expect(
      await refused('POST /api/assistant/turn/:turnId/ui/:callId', CALL, {
        result: { supersede: 1 },
      }),
    ).toBeNull();
  });

  it('a table draft op that deletes a row, column or tab is refused; an edit passes', async () => {
    for (const op of ['row_delete', 'column_delete', 'tab_delete']) {
      expect(
        (
          await refused('POST /api/tables/:id/draft-ops', CALL, {
            ops: [{ op: 'cell_set' }, { op }],
          })
        )?.reason,
        op,
      ).toBe('delete');
    }
    expect(
      await refused('POST /api/tables/:id/draft-ops', CALL, {
        ops: [{ op: 'cell_set', rowId: 'r' }],
      }),
    ).toBeNull();
  });

  it('a task archived is refused as a delete; un-archiving or an edit passes', async () => {
    for (const key of ['PATCH /api/tasks/:id', 'PATCH /api/v1/tasks/:id']) {
      expect((await refused(key, CALL, { archived: true }))?.reason, key).toBe('delete');
      expect(await refused(key, CALL, { archived: false }), key).toBeNull();
      expect(await refused(key, CALL, { title: 'x' }), key).toBeNull();
    }
  });
});

describe('an embed by id is a share (agent-embeds.ts)', () => {
  const HELD = '77777777-7777-4777-8777-777777777771';
  const FRESH = '77777777-7777-4777-8777-777777777772';
  const NOTE = '88888888-8888-4888-8888-888888888881';
  /** The database stood in: the host's held embeds, and whether others
   *  read it (a note in a client-shared folder). */
  const check =
    (shared: boolean) =>
    async (host: string | null, ids: readonly string[]): Promise<boolean> => {
      if (ids.length === 0) return false;
      if (host === null) return true;
      if (ids.every((id) => id === HELD)) return false;
      return shared;
    };
  const send = (key: string, url: string, body: unknown, tag: string | null, shared = true) => {
    const r = row(key);
    return refuseAgentCall(r, req(r.method, tag, body, 'application/json', url), {
      embeds: check(shared),
      lessons: async () => false,
    });
  };
  const noteUrl = `http://brain.invalid/api/notes/${NOTE}`;

  it('a tagged note edit adding a media embed to a shared note is refused; untagged it passes', async () => {
    const body = { content: `see ![x](media:${HELD}) and ![y](media:${FRESH})` };
    const res = await send('PATCH /api/notes/:id', noteUrl, body, CALL);
    expect(res?.status).toBe(403);
    expect(await res!.json()).toEqual({ error: 'agent_refused', reason: 'sharing_field' });
    expect(await send('PATCH /api/notes/:id', noteUrl, body, null)).toBeNull();
    // A plain link to media is an embed edge too.
    expect(
      (await send('PATCH /api/notes/:id', noteUrl, { content: `[f](media:${FRESH})` }, LESSON))
        ?.status,
    ).toBe(403);
  });

  it('a tagged edit that keeps the embeds it had passes; a note only Admin reads passes', async () => {
    expect(
      await send('PATCH /api/notes/:id', noteUrl, { content: `still ![x](media:${HELD})` }, CALL),
    ).toBeNull();
    expect(
      await send('PATCH /api/notes/:id', noteUrl, { content: `![y](media:${FRESH})` }, CALL, false),
    ).toBeNull();
    expect(await send('PATCH /api/notes/:id', noteUrl, { content: 'no embed' }, CALL)).toBeNull();
  });

  it("a page doc's image, file embed or child page, and a drawing draft's file map, count", async () => {
    const pageUrl = `http://brain.invalid/api/pages/${NOTE}`;
    const doc = (node: Record<string, unknown>) => ({
      doc: { type: 'doc', content: [node] },
    });
    for (const n of [
      { type: 'image', attrs: { nodeId: FRESH } },
      { type: 'fileEmbed', attrs: { nodeId: FRESH } },
      { type: 'childPage', attrs: { pageId: FRESH } },
    ]) {
      for (const key of ['PATCH /api/pages/:id', 'PUT /api/pages/:id/draft']) {
        const url = key.startsWith('PUT') ? `${pageUrl}/draft` : pageUrl;
        expect((await send(key, url, doc(n), CALL))?.status, `${key} ${n.type}`).toBe(403);
      }
    }
    expect(
      await send(
        'PATCH /api/pages/:id',
        pageUrl,
        doc({ type: 'image', attrs: { nodeId: HELD } }),
        CALL,
      ),
    ).toBeNull();
    expect(
      (
        await send(
          'PUT /api/draws/:id/draft',
          `http://brain.invalid/api/draws/${NOTE}/draft`,
          { scene: {}, file_refs: { a: FRESH } },
          CALL,
        )
      )?.status,
    ).toBe(403);
  });

  it('a create with an embed is refused (its host is not there to ask); without one it passes', async () => {
    expect(
      (
        await send(
          'POST /api/notes',
          'http://brain.invalid/api/notes',
          { content: `![x](media:${HELD})` },
          CALL,
        )
      )?.status,
    ).toBe(403);
    expect(
      await send(
        'POST /api/notes',
        'http://brain.invalid/api/notes',
        { title: 'n', content: 'x' },
        CALL,
      ),
    ).toBeNull();
  });

  it('every allowlisted route an embed can ride is covered', async () => {
    const { EMBED_SOURCES } = await import('./agent-embeds');
    for (const key of Object.keys(EMBED_SOURCES)) {
      expect(row(key), key).toBeDefined();
      expect(agentRefusesRow(row(key)), key).toBeNull();
    }
    for (const key of [
      'PATCH /api/notes/:id',
      'PATCH /api/pages/:id',
      'PUT /api/pages/:id/draft',
      'PUT /api/draws/:id/draft',
      'POST /api/notes',
      'POST /api/pages',
    ]) {
      expect(Object.hasOwn(EMBED_SOURCES, key), key).toBe(true);
    }
  });
});

describe('a lesson is edited by people (agent-lessons.ts)', () => {
  const LESSON = '99999999-9999-4999-8999-999999999991';
  const OTHER = '99999999-9999-4999-8999-999999999992';
  const lessons = async (id: string) => id === LESSON;
  const send = (key: string, page: string, tag: string | null) => {
    const r = row(key);
    const base = key.includes('/v1/') ? '/api/v1/pages' : '/api/pages';
    const url = `http://brain.invalid${base}/${page}${key.endsWith('/draft') ? '/draft' : ''}`;
    return refuseAgentCall(r, req(r.method, tag, { title: 'x' }, 'application/json', url), {
      lessons,
    });
  };

  it('a tagged write to a lesson page is refused publish; untagged it passes; another page passes', async () => {
    for (const key of [
      'PATCH /api/pages/:id',
      'PATCH /api/v1/pages/:id',
      'PUT /api/pages/:id/draft',
    ]) {
      const res = await send(key, LESSON, LESSON_TAG);
      expect(res?.status, key).toBe(403);
      expect(await res!.json(), key).toEqual({ error: 'agent_refused', reason: 'publish' });
      expect(await send(key, LESSON, null), key).toBeNull();
      expect(await send(key, OTHER, CALL), key).toBeNull();
    }
  });

  const folder = (kind: string, id: string, body: Record<string, unknown>, tag: string | null) => {
    const r = row('PATCH /api/tree/:kind/folders/:id');
    const url = `http://brain.invalid/api/tree/${kind}/folders/${id}`;
    return refuseAgentCall(r, req(r.method, tag, body, 'application/json', url), { lessons });
  };
  const reasonOf = async (res: Response | null) =>
    res === null ? null : ((await res.json()) as { reason: string }).reason;

  it('a tagged rename of a pages folder to "Lessons" (any case, trimmed) is refused publish', async () => {
    for (const name of ['Lessons', '  lessons ', 'LESSONS']) {
      expect(await reasonOf(await folder('pages', OTHER, { name }, CALL)), name).toBe('publish');
    }
    // Untagged, the person names it so; another name, or another kind's
    // folder, passes.
    expect(await folder('pages', OTHER, { name: 'Lessons' }, null)).toBeNull();
    expect(await folder('pages', OTHER, { name: 'Lessons 2' }, CALL)).toBeNull();
    expect(await folder('notes', OTHER, { name: 'Lessons' }, CALL)).toBeNull();
  });

  it('the Lessons folder itself: a tagged rename away or restyle is refused publish; a move in is a move', async () => {
    expect(await reasonOf(await folder('pages', LESSON, { name: 'Old lessons' }, CALL))).toBe(
      'publish',
    );
    expect(await reasonOf(await folder('pages', LESSON, { icon: 'x' }, CALL))).toBe('publish');
    expect(await reasonOf(await folder('pages', OTHER, { parentId: LESSON }, CALL))).toBe('move');
    expect(await reasonOf(await folder('pages', LESSON, { parentId: null }, CALL))).toBe('move');
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
