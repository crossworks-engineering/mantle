/**
 * The one mapper from a workspace user definer's refusal (migration 0305,
 * plan v3.2 S2a a1) to the WsError the route answered before the rule moved
 * to SQL: the SQLSTATE and the message code must both match; anything else
 * is no answer (thrown as it is, the opaque 500).
 */
import { describe, expect, it } from 'vitest';
import { WsError, wsRefusal } from './workspaces';

/** A database error as drizzle wraps it: the PostgresError is the cause. */
const pg = (code: string, message: string) =>
  Object.assign(new Error('Failed query: select ...'), {
    cause: Object.assign(new Error(message), { code }),
  });

describe('wsRefusal', () => {
  it('maps each refusal to today`s WsError', () => {
    const cases: Array<[string, string, number, string, string]> = [
      ['P0002', 'not_found', 404, 'not_found', 'Workspace not found.'],
      ['P0002', 'user_not_found', 404, 'not_found', 'User not found.'],
      ['P0002', 'not_user', 404, 'not_user', 'This person is not a user of this workspace.'],
      [
        '42501',
        'forbidden',
        403,
        'forbidden',
        'Only a Moderator of this workspace can manage its users.',
      ],
      ['55000', 'archived', 409, 'archived', 'This workspace is archived and cannot be changed.'],
      [
        '42501',
        'admin_only',
        403,
        'admin_only',
        'Only an Admin user can make someone a Moderator or take the tick away.',
      ],
      [
        '42501',
        'admin_users_only',
        403,
        'admin_only',
        'Only an Admin user who manages users can change who is an Admin user.',
      ],
      ['55000', 'admin_workspace', 409, 'admin_workspace', ''],
      ['55000', 'already_user', 409, 'already_user', ''],
      ['55000', 'last_moderator', 409, 'last_moderator', ''],
      ['42501', 'owner_stays_admin', 403, 'owner_stays_admin', ''],
      ['42501', 'self_demote', 403, 'self_demote', ''],
    ];
    for (const [state, code, status, wsCode, text] of cases) {
      const e = wsRefusal(pg(state, `mantle_ws:${code} mantle_ws_add_user: why`));
      expect(e, code).toBeInstanceOf(WsError);
      expect([e!.status, e!.code], code).toEqual([status, wsCode]);
      if (text) expect(e!.message, code).toBe(text);
    }
  });

  it('a wrong SQLSTATE, a code it does not answer, or no code is no answer', () => {
    expect(wsRefusal(pg('42501', 'mantle_ws:not_found x'))).toBeNull();
    expect(wsRefusal(pg('42501', 'mantle_ws:no_acting_login x: no acting login'))).toBeNull();
    expect(wsRefusal(pg('42501', 'mantle_ws:read_only x'))).toBeNull();
    expect(wsRefusal(pg('42501', 'permission denied for table workspace_users'))).toBeNull();
    expect(wsRefusal(new Error('boom'))).toBeNull();
  });

  it('the Admin workspace`s last-Moderator check at commit is the last Moderator', () => {
    const e = wsRefusal(pg('23514', 'the Admin workspace needs at least one Moderator'));
    expect(e?.code).toBe('last_moderator');
  });
});
