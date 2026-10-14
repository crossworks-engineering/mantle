/**
 * The audit trail never keeps a personal item's id (final audit F31): every
 * admin reads the log, and the id of an admin's or a member's private item is
 * that login's alone. The insert is stood in; this pins what reaches it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  /** Holds each insert until it settles (auditsSettled). */
  hold: null as Promise<void> | null,
}));

vi.mock('@mantle/db', () => ({
  auditLog: {},
  systemDb: {
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        if (h.hold) await h.hold;
        if (v.action === 'fails') throw new Error('database down');
        h.rows.push(v);
      },
    }),
  },
}));

import {
  auditFireAndForget,
  auditsSettled,
  logAudit,
  redactAuditPath,
  requestMetaFrom,
} from './audit';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

beforeEach(() => {
  h.rows = [];
  h.hold = null;
});

describe('redactAuditPath', () => {
  it('drops the item id from admin and member personal-space paths', () => {
    expect(redactAuditPath(`/api/admin/space/${ID}`)).toBe('/api/admin/space/:id');
    expect(redactAuditPath(`/api/admin/space/${ID}/accept`)).toBe('/api/admin/space/:id/accept');
    expect(redactAuditPath(`/api/member/space/${ID}/draft`)).toBe('/api/member/space/:id/draft');
    expect(redactAuditPath(`/api/member/space/${ID}/comments/c1`)).toBe(
      '/api/member/space/:id/comments/c1',
    );
  });

  it('leaves every other path as it was', () => {
    expect(redactAuditPath('/api/admin/space')).toBe('/api/admin/space');
    expect(redactAuditPath('/api/admin/space-files')).toBe('/api/admin/space-files');
    expect(redactAuditPath(`/api/pages/${ID}`)).toBe(`/api/pages/${ID}`);
    expect(redactAuditPath(null)).toBeNull();
  });
});

describe('logAudit', () => {
  it('writes the redacted path', async () => {
    await logAudit({
      actorId: 'a1',
      actorEmail: 'a@example.invalid',
      action: 'api.write',
      method: 'PUT',
      path: `/api/admin/space/${ID}/draft`,
    });
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]!.path).toBe('/api/admin/space/:id/draft');
    expect(JSON.stringify(h.rows[0])).not.toContain(ID);
  });
});

describe('requestMetaFrom (client logins audit B16)', () => {
  const req = (headers: Record<string, string>) =>
    new Request('https://brain.example.invalid/api/auth/client-link', { headers });

  it('records the hop our proxy appended, never the caller-written leftmost entry', () => {
    // A caller sends its own X-Forwarded-For; Caddy appends what it saw.
    const meta = requestMetaFrom(
      req({ 'x-forwarded-for': '10.9.8.7, 203.0.113.50', 'user-agent': 'UA/1' }),
    );
    expect(meta).toEqual({ ip: '203.0.113.50', userAgent: 'UA/1' });
  });

  it('matches the rate limiter, and records null when there is no address', async () => {
    const { clientIp } = await import('./rate-limit');
    const r = req({ 'x-forwarded-for': '1.2.3.4, 198.51.100.2' });
    expect(requestMetaFrom(r).ip).toBe(clientIp(r));
    expect(requestMetaFrom(req({})).ip).toBeNull();
    expect(requestMetaFrom(req({ 'x-real-ip': '198.51.100.3' })).ip).toBe('198.51.100.3');
  });
});

describe('auditsSettled (A4 step 3b part 5 fix round 1)', () => {
  it('waits for every row in flight, a failed one too; the write stays fire and forget', async () => {
    let release!: () => void;
    h.hold = new Promise((resolve) => (release = resolve));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const row = { actorId: 'a1', actorEmail: 'a@example.invalid', method: 'POST', path: '/x' };
      expect(auditFireAndForget({ ...row, action: 'api.write' })).toBeUndefined();
      auditFireAndForget({ ...row, action: 'fails' as 'api.write' });
      let settled = false;
      const waiting = auditsSettled().then(() => (settled = true));
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(h.rows).toHaveLength(0);
      release();
      await waiting;
      expect(h.rows).toHaveLength(1);
      expect(quiet).toHaveBeenCalledTimes(1);
      // Nothing in flight: it resolves at once.
      await auditsSettled();
    } finally {
      quiet.mockRestore();
    }
  });
});
