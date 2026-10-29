/**
 * The Login of a test's stand-in owner session. Test support: nothing in
 * the app imports it.
 *
 * A DB test that mocks ownerCaller to return a hand-built SessionUser
 * calls a handler with a user no owner answer gave, so ownerUserLogin has
 * none for it and a helper that asks the caller's own facts
 * (adminFacts(login): vaultPairRefusalFor, keysAreaRefusal) answers as for
 * a login without them. This module, spread over the real session module
 * in the test's `vi.mock('@/lib/auth/session', ...)`, gives the stand-in a
 * Login: a fresh one per read (adminFacts keeps its answer per Login, so a
 * limits change between two requests is read again), which loginAdminPair
 * says is an Admin user. The real adminFacts then answers it outside a
 * scope by the login's own row (mantle_login_areas): an Admin user's
 * areas as its limits leave them, a member's none.
 */
import type { Login } from '../auth/login';
import type { SessionUser } from '../auth/session';

type SessionModule = {
  ownerUserLogin: (user: SessionUser) => Login | null;
  loginAdminPair: (login: Login) => boolean;
};

export function standInSession<M extends SessionModule>(real: M, standIn: () => unknown): M {
  const made = new WeakSet<Login>();
  return {
    ...real,
    ownerUserLogin: (user: SessionUser) => {
      if (user !== standIn() || !user?.actor) return real.ownerUserLogin(user);
      const login = {
        loginId: user.actor.id,
        brainId: user.id,
        email: user.actor.email,
        displayName: user.actor.displayName,
        contactId: null,
        source: 'web',
        sessionEpoch: 0,
        actor: user.actor,
      } as unknown as Login;
      made.add(login);
      return login;
    },
    loginAdminPair: (login: Login) => made.has(login) || real.loginAdminPair(login),
  };
}
