/**
 * Stand-ins for a route test that runs with no database through runRoute
 * (run-route.ts). The login rows the pipeline reads come from
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
import type { LoginRole, ScopeArea } from '@mantle/db';
import type { AdminFacts, Login } from '@/lib/auth/login';

/** A stood-in login row, with the workspaces its scope holds. */
export type StandInLogin = {
  id: string;
  role: LoginRole;
  isOwner?: boolean;
  email?: string;
  displayName?: string | null;
  sessionEpoch?: number;
  disabledAt?: Date | null;
  /** A user of the Admin workspace: an Admin login is role admin AND
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

/**
 * A stood-in Login (plan v3.2 section 2.2: no role, no kind) for a test
 * whose code under test reads the Login (anyLoginCaller, chatCaller's
 * asLogin, ownerLoginCaller, publicLoginItself) and asks adminFacts. The
 * Admin facts ride on the object for adminFactsStandIn; the test says them
 * itself, as the scope would answer them.
 */
export type LoginStandIn = Login & {
  readonly standInAdmin: boolean;
  readonly standInAreas: readonly ScopeArea[];
};

export function loginStandIn(l: {
  loginId: string;
  brainId: string;
  email?: string;
  displayName?: string | null;
  contactId?: string | null;
  source?: Login['source'];
  sessionEpoch?: number;
  actor?: Login['actor'];
  /** adminFacts' answer for it: an Admin user (default no) ... */
  admin?: boolean;
  /** ... and the Admin areas it holds (only when admin). */
  areas?: readonly ScopeArea[];
}): LoginStandIn {
  const email = l.email ?? `login-${l.loginId.slice(0, 8)}@example.invalid`;
  const displayName = l.displayName ?? null;
  return {
    loginId: l.loginId,
    brainId: l.brainId,
    email,
    displayName,
    contactId: l.contactId ?? null,
    source: l.source ?? 'web',
    sessionEpoch: l.sessionEpoch ?? 0,
    actor: l.actor ?? {
      id: l.loginId,
      email,
      displayName,
      isOwner: l.loginId === l.brainId,
    },
    standInAdmin: l.admin === true,
    standInAreas: l.admin === true ? (l.areas ?? []) : [],
  };
}

/** adminFacts over stood-in Logins: what the stand-in says, no for any
 *  other object (a Login no stand-in made answers no, as a real one with
 *  no Admin pair does). Wire it in with a vi.mock factory:
 *
 *     vi.mock('@/lib/auth/login', async (importOriginal) => ({
 *       ...(await importOriginal<Record<string, unknown>>()),
 *       adminFacts: vi.fn((await import('@/server/run-route-stand-ins')).adminFactsStandIn),
 *     }));
 */
export async function adminFactsStandIn(login: unknown): Promise<AdminFacts> {
  const l = login as Partial<LoginStandIn> | null | undefined;
  const admin = l?.standInAdmin === true;
  return { admin, areas: new Set(admin ? (l?.standInAreas ?? []) : []) };
}
