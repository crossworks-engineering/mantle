/**
 * Stand-ins for a route test that runs with no database through runRoute
 * (run-route.ts; A4 step 3a). The login rows the pipeline reads come from
 * here, so the gate finds a stood-in login exactly as it finds a real one
 * (the same loadLoginRow, seeding the login's workspaces for the request
 * scope). A test file wires them in with a vi.mock factory:
 *
 *     vi.mock('@/lib/auth/login-row', async () =>
 *       (await import('@/server/run-route-stand-ins')).loginRowStandIn);
 *
 * and names its logins with standInLogin(). Test support only.
 */
// Types only at the top: @mantle/db is often mocked, and a value import here
// would wait on that mock (a cycle).
import type { LoginRole } from '@mantle/db';

/** A stood-in login row, with the workspaces its scope holds. */
export type StandInLogin = {
  id: string;
  role: LoginRole;
  isOwner?: boolean;
  email?: string;
  displayName?: string | null;
  sessionEpoch?: number;
  disabledAt?: Date | null;
  /** A user of the Admin workspace (S8a): an Admin login is role admin AND
   *  this. Default no. */
  adminMember?: boolean;
  /** The workspaces the login is in, and the ones it moderates. */
  ws?: readonly string[];
  modWs?: readonly string[];
};

const logins = new Map<string, StandInLogin>();
let anchorId: string | null = null;

/** Stand in a login row (the brain's owner: `isOwner`, the anchor). */
export function standInLogin(login: StandInLogin): void {
  logins.set(login.id.toLowerCase(), login);
  if (login.isOwner) anchorId = login.id;
}

/** Forget every stood-in login. */
export function clearStandInLogins(): void {
  logins.clear();
  anchorId = null;
}

/** lib/auth/login-row, over the stood-in logins. */
export const loginRowStandIn = {
  loadLoginRow: async (id: string) => {
    const l = logins.get(id.toLowerCase());
    if (!l) return null;
    const { seedLoginScope } = await import('@mantle/db');
    seedLoginScope(l.id, l.ws ?? [], l.modWs ?? []);
    return {
      id: l.id,
      email: l.email ?? `${l.role}-${l.id.slice(0, 4)}@example.invalid`,
      isOwner: l.isOwner ?? false,
      displayName: l.displayName ?? null,
      role: l.role,
      adminMember: l.adminMember ?? false,
      contactId: null,
      disabledAt: l.disabledAt ?? null,
      sessionEpoch: l.sessionEpoch ?? 0,
    };
  },
  loadAnchorId: async () => anchorId,
  loadPersonalSpaceId: async () => null,
  loadBearerToken: async () => null,
  touchBearerToken: async () => undefined,
};
