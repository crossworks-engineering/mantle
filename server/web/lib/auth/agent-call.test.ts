/**
 * The brain's refusal of an agent-driven risky write (docs/agent-ui.md): a
 * non-GET carrying `x-mantle-agent-call` to a route that deletes, sends,
 * shares, publishes or changes a setting is 403 `{ error: 'needs_user' }`,
 * whatever the client did. Read against every row the route declarations
 * give (the pinned snapshot, __snapshots__/route-policy.rows.json), so a new
 * route is judged the day it lands.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_CALL_HEADER } from '@mantle/client-types/agent-ui';
import {
  AGENT_REFUSED_EXACT,
  AGENT_REFUSED_PREFIXES,
  agentRefusesRow,
  refuseAgentCall,
} from './agent-call';

type Snap = Record<string, { effect: 'read' | 'write'; area?: string | null }>;
const ROWS = Object.entries(
  JSON.parse(
    readFileSync(new URL('./__snapshots__/route-policy.rows.json', import.meta.url), 'utf8'),
  ) as Snap,
).map(([key, r]) => {
  const [method, pattern] = key.split(' ', 2) as [string, string];
  return { method, pattern, area: (r.area ?? null) as never, effect: r.effect };
});
const row = (key: string) => {
  const found = ROWS.find((r) => `${r.method} ${r.pattern}` === key);
  if (!found) throw new Error(`no row ${key}`);
  return found;
};

const req = (method: string, header = true) =>
  new Request('http://brain.invalid/x', {
    method,
    headers: header ? { [AGENT_CALL_HEADER]: '33333333-3333-4333-8333-333333333333' } : {},
  });

describe('refuseAgentCall', () => {
  it('refuses a risky write that carries the header, 403 needs_user', async () => {
    const res = refuseAgentCall(row('POST /api/shares'), req('POST'));
    expect(res?.status).toBe(403);
    expect(await res!.json()).toEqual({ error: 'needs_user' });
  });

  it('lets the same write through without the header (the person allowed it)', () => {
    expect(refuseAgentCall(row('POST /api/shares'), req('POST', false))).toBeNull();
  });

  it('never refuses a read, with the header or not', () => {
    for (const r of ROWS.filter((x) => x.method === 'GET' || x.method === 'HEAD')) {
      expect(refuseAgentCall(r, req(r.method)), `${r.method} ${r.pattern}`).toBeNull();
    }
  });

  it('lets an ordinary content write through (an agent may edit what the person may)', () => {
    for (const key of [
      'PATCH /api/pages/:id',
      'POST /api/notes',
      'PATCH /api/tasks/:id',
      'POST /api/messenger/c/:id/read',
      'POST /api/assistant/turn/:turnId/ui/:callId',
    ]) {
      expect(refuseAgentCall(row(key), req(row(key).method)), key).toBeNull();
    }
  });

  it('refuses every DELETE and every Admin-area write', () => {
    const risky = ROWS.filter(
      (r) => r.effect === 'write' && (r.method === 'DELETE' || r.area !== null),
    );
    expect(risky.length).toBeGreaterThan(50);
    for (const r of risky) expect(agentRefusesRow(r), `${r.method} ${r.pattern}`).toBe(true);
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
      expect(agentRefusesRow(row(key)), key).toBe(true);
    }
  });

  it("a chat's PATCH is refused as itself only: marking the chat read stays open", () => {
    expect(refuseAgentCall(row('PATCH /api/messenger/c/:id'), req('PATCH'))?.status).toBe(403);
    expect(refuseAgentCall(row('POST /api/messenger/c/:id/typing'), req('POST'))?.status).toBe(403);
    expect(agentRefusesRow(row('POST /api/messenger/c/:id/read'))).toBe(false);
    expect(refuseAgentCall(row('GET /api/messenger/c/:id'), req('GET'))).toBeNull();
  });

  it("leaves the window's own answer and a turn's cancel open", () => {
    for (const key of [
      'POST /api/assistant/turn/:turnId/ui/:callId',
      'POST /api/assistant/turn/:turnId/cancel',
    ]) {
      expect(agentRefusesRow(row(key)), key).toBe(false);
    }
  });

  it('every exact route exists', () => {
    for (const p of AGENT_REFUSED_EXACT) {
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
