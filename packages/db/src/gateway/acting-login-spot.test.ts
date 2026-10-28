/**
 * The gateway sends the exit's acting login at the full-route spot
 * login-credential in every check mode, the actor check off too (plan v3.2
 * S8b; r6 app re-audit L3). The Users screen's role change and the admin
 * login create call the Admin membership definers with no scope there; with
 * no scope those take the exit's acting login (mantle_ws_exit_login, 0330).
 * On a narrow exit the spot's entry is the spot's own, no request exit
 * (requestExitActingLogin answers null inside it), so with the check off
 * only actingLoginAtSpot puts the acting login in the SET: removing
 * 'login-credential' from it fails this file, not only the narrow sweep.
 * No database: actorParams is what the gateway's SET is made of.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginActor, runAsActor } from '../actor';
import {
  actingLoginAtSpot,
  asSystem,
  noteRequestSystem,
  onFullSystemRoute,
  requestExitActingLogin,
  runInRequestSlot,
  setRequestActor,
  systemRouteNow,
} from '../viewer';
import { actorParams } from './actor-sql';

const admin = randomUUID();

/** `fn` in the Admin area's request exit of the Admin login (the Users
 *  screen's route). */
const requestExit = <T>(fn: () => Promise<T>) =>
  runInRequestSlot(async () => {
    setRequestActor(loginActor(admin, 'rw'));
    noteRequestSystem('area');
    return fn();
  });

/** `fn` in an asSystem('admin-area') exit of the Admin login. */
const asSystemExit = <T>(fn: () => Promise<T>) =>
  runAsActor(loginActor(admin, 'rw'), () => asSystem(fn, 'admin-area'));

describe('the acting login at the login-credential spot, the actor check off', () => {
  beforeEach(() => {
    vi.stubEnv('MANTLE_ACTOR_CHECK', 'off');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  for (const [name, exit] of [
    ['request exit', requestExit],
    ['asSystem exit', asSystemExit],
  ] as const) {
    it(`${name}: the SET carries the acting login at the spot, and the full route`, async () => {
      const out = await exit(async () => ({
        route: systemRouteNow(),
        atSpot: await onFullSystemRoute('login-credential', async () => ({
          requestExit: requestExitActingLogin(),
          spot: actingLoginAtSpot(),
          params: actorParams(),
        })),
      }));
      // The exit is a narrow one (the switch on), so the spot is a real one.
      expect(out.route).toBe('narrow');
      // Inside the spot no request exit answers: only the spot sends it.
      expect(out.atSpot.requestExit).toBeNull();
      expect(out.atSpot.spot).toBe(admin);
      expect(out.atSpot.params).not.toBeNull();
      expect(out.atSpot.params![3]).toBe('full');
      expect(out.atSpot.params![4]).toBe(admin);
    });
  }

  it('another spot sends no acting login with the check off (the SET is only these spots`)', async () => {
    const params = await asSystemExit(() =>
      onFullSystemRoute('profile-row', async () => actorParams()),
    );
    expect(params).toBeNull();
  });
});
