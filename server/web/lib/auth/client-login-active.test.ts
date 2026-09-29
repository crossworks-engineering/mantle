/**
 * clientLoginActive (client logins audit B24): the re-check a queued client
 * turn (Phase C4) makes before it acts. The login row is re-read; only an
 * enabled CLIENT login still on the session epoch the work began under
 * passes. The epoch is required: work started before an End sessions or a
 * sign-out must stop too. No database: the row comes from a stand-in.
 */
import { describe, expect, it, vi } from 'vitest';

const CLIENT = '12121212-1212-4212-8212-121212121212';
const DISABLED = '14141414-1414-4414-8414-141414141414';
const MEMBER = '22222222-2222-4222-8222-222222222222';

const row = (id: string, role: string, extra: { disabledAt?: Date } = {}) => ({
  id,
  email: `${role}@example.invalid`,
  isOwner: false,
  displayName: null,
  role,
  contactId: null,
  disabledAt: extra.disabledAt ?? null,
  sessionEpoch: 4,
});

vi.mock('./login-row', () => ({
  loadLoginRow: async (id: string) =>
    ({
      [CLIENT]: row(CLIENT, 'client'),
      [DISABLED]: row(DISABLED, 'client', { disabledAt: new Date('2026-09-01T00:00:00Z') }),
      [MEMBER]: row(MEMBER, 'member'),
    })[id] ?? null,
  loadAnchorId: async () => null,
  loadPersonalSpaceId: async () => null,
}));

import { clientLoginActive } from './session';

describe('clientLoginActive', () => {
  it('passes an enabled client on its current epoch only', async () => {
    expect(await clientLoginActive(CLIENT, 4)).toBe(true);
    for (const epoch of [0, 3, 5]) expect(await clientLoginActive(CLIENT, epoch)).toBe(false);
  });

  it('refuses a disabled client, another role and an unknown login', async () => {
    expect(await clientLoginActive(DISABLED, 4)).toBe(false);
    expect(await clientLoginActive(MEMBER, 4)).toBe(false);
    expect(await clientLoginActive('99999999-9999-4999-8999-999999999999', 4)).toBe(false);
  });

  it('requires the epoch (a type error without it)', () => {
    // Never called: this only has to type-check, and only with the error.
    const typeOnly = () =>
      // @ts-expect-error the epoch the work began under is required
      clientLoginActive(CLIENT);
    expect(typeof typeOnly).toBe('function');
  });
});
