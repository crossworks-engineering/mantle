/**
 * The audit trail never keeps a personal item's id (final audit F31): every
 * admin reads the log, and the id of an admin's or a member's private item is
 * that login's alone. The insert is stood in; this pins what reaches it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock('@mantle/db', () => ({
  auditLog: {},
  systemDb: {
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        h.rows.push(v);
      },
    }),
  },
}));

import { logAudit, redactAuditPath } from './audit';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

beforeEach(() => {
  h.rows = [];
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
