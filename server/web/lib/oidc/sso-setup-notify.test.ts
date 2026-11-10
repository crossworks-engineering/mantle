/**
 * The setup screen's notice (notify.ts notifySsoSetupChange): to the original
 * account, one fixed text per kind, never a value, and a failure stays here, so
 * a failed push cannot lose a token a route has stored. The real push: a paired
 * device, not run here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  anchor: 'the-original-account' as string | null,
  notices: [] as Record<string, unknown>[],
  fails: false,
}));

vi.mock('@/lib/auth/login-row', () => ({ loadAnchorId: async () => h.anchor }));
vi.mock('@/lib/access-keys-notify', () => ({
  noticeToLogin: async (n: Record<string, unknown>) => {
    if (h.fails) throw new Error('the relay is gone');
    h.notices.push(n);
  },
}));

const { notifySsoSetupChange } = await import('./notify');

beforeEach(() => {
  h.anchor = 'the-original-account';
  h.notices = [];
  h.fails = false;
});

describe('notifySsoSetupChange', () => {
  it.each(['secret', 'scim-token'] as const)('%s: tells the original account', async (kind) => {
    await notifySsoSetupChange(kind);
    expect(h.notices).toEqual([
      expect.objectContaining({
        ownerId: 'the-original-account',
        loginId: 'the-original-account',
        admin: true,
        deepLink: '/admin/company-sign-in',
      }),
    ]);
  });

  it('has a different fixed text for each kind', async () => {
    await notifySsoSetupChange('secret');
    await notifySsoSetupChange('scim-token');
    expect(h.notices[0]!.text).toContain('client secret');
    expect(h.notices[1]!.text).toContain('SCIM token');
  });

  it('never throws: a failed push cannot lose what the route stored', async () => {
    h.fails = true;
    await expect(notifySsoSetupChange('scim-token')).resolves.toBeUndefined();
  });

  it('with no original account says nothing', async () => {
    h.anchor = null;
    await notifySsoSetupChange('secret');
    expect(h.notices).toEqual([]);
  });
});
