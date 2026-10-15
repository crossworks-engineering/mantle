/**
 * The guard sweep (arch A4 step 3a): for every route of the manifest and
 * every page, every method, and every kind of credential, what the request
 * gets and what each session guard answered on the way. Recorded on main
 * (v0.300.28) BEFORE the gate resolved the login, and committed: step 3a
 * moves the login's resolution into the gate and turns each guard into a
 * reader of the bound caller, and this file must not change.
 *
 * Per request it records the answer (status, the headers a client reads,
 * the body of a refusal) and, per guard call, the guard's answer (its
 * refusal, or the login it resolved), the actor the request runs as after
 * it, and what the guard did with the request's scope (the outcome). A
 * guard that lets a login through stops the handler right there (SweepStop),
 * so nothing past the guard runs: the sweep proves the guards, and no
 * handler touches a database it does not have.
 *
 * No database: the login rows, the device tokens and the keys come from
 * stand-ins, as in the member and role sweeps.
 *
 * A second sweep (A4 step 3a audit L2), recorded on v0.300.28 too, in a
 * file of its own so the first stays byte for byte: more credentials (a
 * disabled login's cookie, a cookie from before an epoch bump, a deleted
 * login's cookie, a rotated device token presented again, an expired
 * device token, an unknown and a revoked key), and the cells of the first
 * sweep where a guard threw for want of a database, driven again with the
 * stand-ins that answer the guard's item and scope queries (READS).
 *
 * Step 3b moves guard calls to the pipeline, batch by batch (docs/actors.md):
 * a converted handler reads the caller the gate answered (ownerCaller())
 * and the gate runs the owner guard's answer itself, before the handler
 * (answerRouteCaller). Its entry in the guard log moves with it: the
 * pipeline's answer is logged at the gate, with the same answer, actor and
 * scope after it, named by the reader the handler reads (`pipeline:owner`
 * for ownerCaller(), `pipeline:ownerWithSource`, `pipeline:ownerWithLogin`;
 * a4-guard-sweep.readers.ts reads it from the route file) and logging the
 * projection that reader reads. The two recorded files compare a moved
 * entry under the guard that reader replaced (LEGACY_NAMES): they stay
 * byte for byte. The moved entries, as logged, are recorded in a
 * third file (`__snapshots__/a4-guard-sweep-moved.txt`), one line per cell
 * whose entry moved, so each move is on the record and reviewed.
 *
 * What a write did on the side (its audit rows, the create home) is in no
 * recorded file. A moved write's is recorded as the pipeline drove it
 * (`a4-guard-sweep-moved-writes.txt`, part 4), and since part 5 fix round 1
 * the guard path's too: every cell of a write a guard still answers, keyed
 * by the guard's name (`a4-guard-sweep-guard-writes.txt`), with the
 * any-login audit row (since A4 hand batch A written inside getLoginOr401
 * when its caller asks, as workspaceCaller() and POST /api/auth/pair do;
 * before, they wrote it by hand after the guard and the sweep let that call
 * run). That file is the baseline: when a row moves,
 * its cells stay in it under the guard its reader replaced, and the test
 * holds each to the guard path's record before it compares the file, so a
 * lost or a doubled audit row fails by cell.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ANCHOR_ID = '33333333-3333-4333-8333-333333333333';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
/** An admin that holds no Admin area (requireArea answers false). */
const LIMITED_ID = '44444444-4444-4444-8444-444444444444';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const SPACE_ID = '66666666-6666-4666-8666-666666666666';
const NODE_ID = '11111111-1111-4111-8111-111111111111';
/** A disabled login, one whose epoch moved on, and one that is gone. */
const DISABLED_ID = '77777777-7777-4777-8777-777777777777';
const BUMPED_ID = '88888888-8888-4888-8888-888888888888';
const GONE_ID = '99999999-9999-4999-8999-999999999999';

const sweepState = vi.hoisted(() => ({
  bearers: new Map<
    string,
    { userId: string; revokedAt: Date | null; expiresAt: Date; rotatedTo: string | null }
  >(),
  /** The guard calls of the request being driven. */
  log: [] as string[],
  /** The database's reads stood in (the second sweep only). */
  reads: false,
  /** The audit rows the request wrote, and the create home the pipeline's
   *  answer named (A4 step 3b part 4): recorded for a moved write entry
   *  only, in a file of its own (the recorded files never see them). */
  audits: [] as string[],
  home: null as string | null,
  /** The create home the request noted, by whichever path noted it (the
   *  guard's or the pipeline's): the guard writes' record (A4 step 3b part
   *  5 fix round 1), read alike on both paths. */
  noted: null as string | null,
}));

const loginRow = (
  id: string,
  role: string,
  isOwner = false,
  more: { disabledAt?: Date; sessionEpoch?: number } = {},
) => ({
  id,
  email: `${role}-${id.slice(0, 4)}@example.invalid`,
  isOwner,
  displayName: `${role} ${id.slice(0, 4)}`,
  role,
  contactId: null,
  disabledAt: more.disabledAt ?? null,
  sessionEpoch: more.sessionEpoch ?? 0,
});

vi.mock('../lib/brain-identity', () => ({
  brainIdOrNull: async () => '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
  getBrainId: async () => '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f',
  brainIdField: async () => ({ brainId: '0b7c6a1e-2f4d-4c1a-9e8b-5d3f2a1c0e9f' }),
}));

vi.mock('../lib/auth/login-row', () => ({
  loadLoginRow: async (id: string) =>
    id === ANCHOR_ID
      ? loginRow(ANCHOR_ID, 'admin', true)
      : id === ADMIN_ID
        ? loginRow(ADMIN_ID, 'admin')
        : id === LIMITED_ID
          ? loginRow(LIMITED_ID, 'admin')
          : id === MEMBER_ID
            ? loginRow(MEMBER_ID, 'member')
            : id === DISABLED_ID
              ? loginRow(DISABLED_ID, 'admin', false, { disabledAt: new Date(0) })
              : id === BUMPED_ID
                ? loginRow(BUMPED_ID, 'admin', false, { sessionEpoch: 1 })
                : null,
  loadAnchorId: async () => ANCHOR_ID,
  loadPersonalSpaceId: async () => SPACE_ID,
  loadBearerToken: async (jti: string) => sweepState.bearers.get(jti) ?? null,
  touchBearerToken: async (jti: string) => {
    sweepState.log.push(`touch ${jti.slice(0, 8)}`);
  },
}));

// The audit row a write makes (fire and forget): kept for the moved
// writes' record, never written.
vi.mock('../lib/audit', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditFireAndForget: (e: {
    action: string;
    method?: string;
    path?: string;
    actorId: string;
    detail?: { keyId?: string };
  }) => {
    sweepState.audits.push(
      `${e.action} ${e.method ?? ''} ${e.path ?? ''} ${e.actorId}${e.detail?.keyId ? ` key:${e.detail.keyId.slice(0, 8)}` : ''}`,
    );
  },
}));

vi.mock('../lib/mcp-auth', () => ({
  mcpLoginEnabled: async () => false,
  mcpTargetLogin: async () => null,
}));

vi.mock('../lib/mcp-oauth', async (importOriginal) => {
  const { SWEEP_OAUTH_CLIENT } = await import('./public-session-routes');
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    isRemoteMcpEnabled: async () => true,
    getClient: async (id: string) =>
      id === SWEEP_OAUTH_CLIENT.id
        ? { id, clientName: 'Sweep client', redirectUris: [SWEEP_OAUTH_CLIENT.redirectUri] }
        : null,
  };
});

vi.mock('../lib/pair-code', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  issuePairCode: async () => ({
    id: '00000000-0000-4000-8000-0000000000c0',
    code: 'sweep-code-sweep-code-sweep',
    expiresAt: new Date(Date.now() + 90_000),
  }),
  pairCodeStatus: async () => ({ status: 'pending', deviceLabel: null }),
}));

vi.mock('../lib/shares', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveActiveShareByToken: async () => null,
  resolveActiveShareRowByToken: async () => null,
}));
vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isRetiredTeamLinkToken: async () => false,
  isRetiredClientLinkToken: async () => false,
}));

// The keys: verified by their token, every budget open (no rate limit
// differs between two runs of the sweep).
vi.mock('../lib/access-keys', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/access-keys')>();
  const { KEY_GRANTS, KEY_REFUSALS } = await import('./a4-guard-sweep.keys');
  const open = { ok: true as const, remaining: 1, retryAfterSec: 0 };
  return {
    ...real,
    verifyAccessKey: async (token: string) => {
      const grant = KEY_GRANTS[token];
      const refused = KEY_REFUSALS[token];
      return grant
        ? { ok: true as const, grant }
        : refused
          ? { ok: false as const, ...refused }
          : { ok: false as const, reason: 'unknown' };
    },
    rateLimitAccessKey: () => open,
    rateLimitKeySearch: () => open,
    failedKeyBudget: () => open,
    countFailedKey: () => undefined,
    touchAccessKey: () => undefined,
    auditKeyRefusal: () => undefined,
  };
});

vi.mock('@mantle/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@mantle/db')>();
  // READS (the second sweep only): the database's reads a guard asks are
  // answered. A query (db.select and its chain) finds no row; a statement
  // (db.execute: the item a write names, through a share or a revision,
  // and what the login may do to it) finds one item the login may edit and
  // manage; withViewer runs its function. Writes are not stood in. Off,
  // everything is the real module's: the first sweep is unchanged.
  const none: unknown = new Proxy(() => undefined, {
    get: (_t, k) =>
      k === 'then'
        ? (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
            Promise.resolve([]).then(ok, ko)
        : () => none,
  });
  const db = new Proxy(real.db, {
    get: (t, k) => {
      if (sweepState.reads && k === 'select') return () => none;
      if (sweepState.reads && k === 'execute') {
        return async () => [
          {
            id: NODE_ID,
            type: 'page',
            edit: true,
            manage: true,
            copy: false,
            home: null,
            held: false,
          },
        ];
      }
      return Reflect.get(t, k);
    },
  });
  return {
    ...real,
    db,
    withViewer: ((actsFor, fn) =>
      sweepState.reads ? fn() : real.withViewer(actsFor, fn)) as typeof real.withViewer,
    loginScopeFor: async (loginId: string) => ({ kind: 'user', loginId, ws: [], modWs: [] }),
    noteRequestCreateHome: ((home) => {
      sweepState.noted = JSON.stringify(home);
      real.noteRequestCreateHome(home);
    }) as typeof real.noteRequestCreateHome,
    brainOnWorkspacesNow: async () => true,
    createHomeIntent: async () => ({ createWs: null, privateWs: null }),
  };
});
vi.mock('../lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/workspaces')>()),
  requireArea: async (caller: { loginId: string }) => caller.loginId !== LIMITED_ID,
}));

/** Thrown by a guard's stand-in once it let a login through: the handler
 *  goes no further. */
class SweepStop extends Error {
  constructor() {
    super('sweep stop');
    this.name = 'SweepStop';
  }
}

vi.mock('../lib/auth/session', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  const db = await import('@mantle/db');
  const { NextResponse } = await import('./http-compat');
  const { summarize } = await import('./a4-guard-sweep.keys');
  const after = () => {
    const actor = db.currentActor();
    const out = db.currentRequestOutcome();
    return (
      `actor=${actor ? db.actorSetting(actor) : '-'}` +
      ` out=${out ? `${out.kind}:${'why' in out ? out.why : 'writes' in out ? out.writes : ''}` : '-'}`
    );
  };
  // The session guards, each wrapped to record its answer: the one list
  // (eslint-rules/session-guards.mjs), read here (the factory is hoisted).
  const { SESSION_GUARDS: GUARDS } = await import('../../../eslint-rules/session-guards.mjs');
  const wrapped: Record<string, unknown> = { ...real, endLoginSessions: async () => 1 };
  // The pipeline's answer of the owner caller (A4 step 3b): logged at the
  // gate as the guard's answer was in the handler. Rows with no caller
  // are answered by their guard (no entry).
  //
  // Its entry is named by the reader the row's handler reads, and logs the
  // projection that reader reads (A4 step 3b part 3): `pipeline:owner`
  // for ownerCaller() (getOwnerOr401's answer), `pipeline:ownerWithSource`
  // and `pipeline:ownerWithLogin` for the other two. The reader comes from
  // the route file's own code (the one reader of the one list it calls),
  // following an /api/v1 file's re-export to its base route.
  type Row = { key: string; caller: string | null };
  const answer = real.answerRouteCaller as (row: Row) => Promise<unknown>;
  const { readerOfRow } = await import('./a4-guard-sweep.readers');
  // The entry's name, by the reader (A4 step 3b part 5: the member,
  // any-login and chat readers too; the one list, session-guards.mjs).
  const { READER_ANSWERS: ENTRIES } = await import('../../../eslint-rules/session-guards.mjs');
  wrapped.answerRouteCaller = async (row: Row) => {
    if (!row.caller) return answer(row);
    const reader = readerOfRow(row.key);
    // A4 hand batch B: an answer taken at the read is logged by its reader,
    // where the handler reads it (below), as the guard's was; the frame
    // ticket replaced no guard (the frame documents read none) and logs
    // nothing, as nothing was logged there.
    if (ENTRIES[reader]!.atRead || ENTRIES[reader]!.guard === null) return answer(row);
    const name = ENTRIES[reader]!.entry;
    const project = real[reader] as () => unknown;
    let value: unknown;
    try {
      value = await answer(row);
    } catch (err) {
      const e = err as { name?: string; location?: string; message?: string };
      sweepState.log.push(
        `${name} threw ${e.name ?? '?'} ${e.location ?? (e.message ?? '').split('\n')[0]!.slice(0, 80)} ${after()}`,
      );
      throw err;
    }
    if (value instanceof NextResponse) {
      const body = await value.clone().text();
      sweepState.log.push(`${name} R${value.status} ${body.slice(0, 300)} ${after()}`);
      return value;
    }
    sweepState.log.push(`${name} ok ${summarize(project())} ${after()}`);
    const home = db.currentCreateHome();
    sweepState.home = home ? JSON.stringify(home) : null;
    return value;
  };
  // The gate's Admin step on a row whose handler reads the pipeline's
  // caller and manages an area (A4 step 3b part 4): the login's effects are
  // applied before step 5 (enterRouteLogin), and step 5 refuses a login
  // without the area, before the pipeline's answer. Its refusal is that
  // answer's entry, logged in the request slot (the actor after it), named
  // by the row's reader as the answer would be: the guard refused there.
  const { mapAccessError } = await import('@mantle/std');
  const enterRouteLogin = real.enterRouteLogin as (fn: () => Promise<unknown>) => Promise<unknown>;
  wrapped.enterRouteLogin = (fn: () => Promise<unknown>) =>
    enterRouteLogin(async () => {
      try {
        return await fn();
      } catch (err) {
        const http = mapAccessError(err)?.http;
        const row = (await import('../lib/auth/route-policy')).currentRoute();
        if (http && row && !sweepState.log.some((l) => l.startsWith('pipeline:'))) {
          const name = ENTRIES[readerOfRow(row.key)]!.entry;
          sweepState.log.push(
            `${name} R${http.status} ${JSON.stringify(http.body).slice(0, 300)} ${after()}`,
          );
        }
        throw err;
      }
    });
  // The handler's read of it (any reader of the one list): the handler
  // goes no further, as after a guard that let a login through. A read of
  // no login (sessionUserCaller(): getSessionUser's null, A4 hand batch A)
  // goes on, as after a guard that answered null.
  //
  // A4 hand batch B: the frame ticket is no login (the frame documents
  // called no guard): read as it is. An answer taken at the read
  // (publicLoginCaller(), cookieUpgradeCaller(), ownerCallerAtRead()) is
  // logged here, where its guard was called and logged, under its entry,
  // as the guard's: a login let through stops the handler, a public row's
  // null goes on (its guard's refusal was handed back, logged with the 401
  // the handler answers it with, unauthorizedRefusal()), an owner's refusal
  // is thrown on (the app answers it).
  const { CALLER_READERS: READERS } = await import('../../../eslint-rules/session-guards.mjs');
  for (const name of READERS) {
    const spec = ENTRIES[name]!;
    if (spec.guard === null) continue;
    if (spec.atRead) {
      const take = real[name] as (...a: unknown[]) => Promise<unknown>;
      const Refusal = real.RouteRefusal as new (...a: unknown[]) => { response: Response };
      const unauthorized = real.unauthorizedRefusal as () => Response;
      wrapped[name] = async (...args: unknown[]) => {
        let value: unknown;
        try {
          value = await take(...args);
        } catch (err) {
          if (err instanceof Refusal) {
            const body = await err.response.clone().text();
            sweepState.log.push(
              `${spec.entry} R${err.response.status} ${body.slice(0, 300)} ${after()}`,
            );
            throw err;
          }
          const e = err as { name?: string; location?: string; message?: string };
          sweepState.log.push(
            `${spec.entry} threw ${e.name ?? '?'} ${e.location ?? (e.message ?? '').split('\n')[0]!.slice(0, 80)} ${after()}`,
          );
          throw err;
        }
        if (value === null) {
          const refusal = unauthorized();
          sweepState.log.push(
            `${spec.entry} R${refusal.status} ${(await refusal.text()).slice(0, 300)} ${after()}`,
          );
          return value;
        }
        sweepState.log.push(`${spec.entry} ok ${summarize(value)} ${after()}`);
        throw new SweepStop();
      };
      continue;
    }
    const read = real[name] as () => unknown;
    wrapped[name] = () => {
      const value = read();
      if (value === null) return value;
      throw new SweepStop();
    };
  }
  for (const name of GUARDS) {
    const fn = real[name] as (...a: unknown[]) => Promise<unknown>;
    wrapped[name] = async (...args: unknown[]) => {
      let value: unknown;
      try {
        value = await fn(...args);
      } catch (err) {
        const e = err as { name?: string; location?: string; message?: string };
        sweepState.log.push(
          `${name} threw ${e.name ?? '?'} ${e.location ?? (e.message ?? '').split('\n')[0]!.slice(0, 80)} ${after()}`,
        );
        throw err;
      }
      if (value instanceof NextResponse) {
        const body = await value.clone().text();
        sweepState.log.push(`${name} R${value.status} ${body.slice(0, 300)} ${after()}`);
        return value;
      }
      sweepState.log.push(`${name} ok ${summarize(value)} ${after()}`);
      if (value === null) return value;
      throw new SweepStop();
    };
  }
  return wrapped;
});

import { SESSION_COOKIE_NAME, RENDER_COOKIE_NAME } from '../lib/auth-constants';
import { KEY_TOKENS } from './a4-guard-sweep.keys';
import { READER_ANSWERS, SESSION_GUARDS } from '../../../eslint-rules/session-guards.mjs';
import { auditsAsWrite, isReadRequest } from '../lib/auth/route-scope';
import {
  ANY_LOGIN_ROUTES,
  CHAT_LOGIN_ROUTES,
  TELEGRAM_LOGIN_ROUTES,
} from '../lib/auth/any-login-routes';

const here = dirname(fileURLToPath(import.meta.url));
const hasManifest = existsSync(join(here, 'route-manifest.gen.ts'));
if (!hasManifest && process.env.CI) {
  throw new Error('server/web/server/route-manifest.gen.ts is missing: the sweep cannot run');
}

function concretePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z0-9_]+\??/g, NODE_ID).replace(/\*$/, 'a/b');
}

/** One credential: its headers, and a query string it adds. GET only for
 *  the URL-borne ones (a GET is all they ever open). */
type Cred = { name: string; headers: Record<string, string>; query?: string; getOnly?: boolean };

/** The guard each pipeline entry stands for in the two recorded files: the
 *  guard the converted handler called, named by the reader that replaced
 *  it (the one list, session-guards.mjs READER_ANSWERS: ownerCaller():
 *  getOwnerOr401, batches 1 to 4; ownerCallerWithSource():
 *  getOwnerOr401WithSource; ownerCallerWithLogin():
 *  getOwnerOr401WithLogin, batch 3's app brokers and frame ticket;
 *  memberCaller(): getMemberOr401, loginCaller(): getLoginOr401 and
 *  chatLoginCaller(): getChatLoginOr401, batch 5). Each entry logs the
 *  projection its reader reads. */
const LEGACY_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.values(READER_ANSWERS).flatMap((r) => (r.guard === null ? [] : [[r.entry, r.guard]])),
);

/** An answer as the recorded files spell it: a moved entry under the name
 *  of the guard it replaced. Everything else is the answer as driven. */
function legacy(answer: string): string {
  return answer.replace(/\[(pipeline:[A-Za-z]+) /g, (whole, name: string) =>
    LEGACY_NAMES[name] ? `[${LEGACY_NAMES[name]} ` : whole,
  );
}

/** The cells whose guard entry moved to the pipeline, as driven: sweep and
 *  cell to its answer. */
const moved = new Map<string, string>();
/** The moved cells of a write (auditsAsWrite, as the audit hook decides:
 *  a mutating method, or a row whose effect is a write, so a connector's
 *  OAuth callback GET and HEAD too), to what the request wrote on the side:
 *  its audit rows, and the create home the pipeline's answer named (A4 step
 *  3b part 4). */
const movedWrites = new Map<string, string>();
/**
 * The owner's decision of 2026-10-14 (docs/actors.md, A4 step 3b part 4):
 * GET and HEAD /api/updates/status and POST /api/updates/check need the
 * settings area their rows name (before: any Admin user; a member and no
 * login the handler's 401). Their cells in the recorded files changed on
 * purpose, and only theirs; each is recorded as driven in a file of its
 * own (`__snapshots__/a4-guard-sweep-owner-decision.txt`).
 */
const OWNER_DECISION_ROWS: ReadonlySet<string> = new Set([
  'GET /api/updates/status',
  'HEAD /api/updates/status',
  'POST /api/updates/check',
]);
const ownerDecision = new Map<string, string>();
/**
 * The owner's decision of 2026-10-14, 1a (docs/actors.md, A4 hand batch
 * A): the any-login handlers of the four ruleInQuery files read the login
 * the pipeline answered before they leave the request scope by name
 * (asSystem 'rule-in-query'). Before, the whole handler ran inside the
 * exit, the guard included, so the actor the sweep notes after the guard
 * was system:rule-in-query; the gate answers outside it, so a refusal is
 * noted as system:http:no-login and a login let through as the login.
 * Nothing on the wire changes, and the body still runs inside the exit.
 * Their cells in the recorded files changed there, and only there; each is
 * recorded as driven in a file of its own
 * (`__snapshots__/a4-guard-sweep-rule-in-query.txt`).
 */
const RULE_IN_QUERY_ROWS: ReadonlySet<string> = new Set([
  'GET /api/shell',
  'HEAD /api/shell',
  'GET /api/v1/whoami',
  'HEAD /api/v1/whoami',
  'GET /api/access-keys',
  'HEAD /api/access-keys',
  'POST /api/access-keys',
  'DELETE /api/access-keys/:id',
]);
const ruleInQueryCells = new Map<string, string>();
/**
 * The owner's decision of 2026-10-14, 2a (docs/actors.md, A4 hand batch A,
 * the open question M3): a HEAD row has its GET row's logins. The HEADs of
 * the any-login, chat and Telegram lists' GET rows ran the GET handler on
 * the system pool (login-self) for every login; they run under the login's
 * own rule now, as their GET does (its scope; an Admin user's read too, on
 * a workspaces brain). Their cells in the recorded files changed in the
 * actor and the request outcome the sweep notes after the login's answer,
 * and only there; each is recorded as driven in a file of its own
 * (`__snapshots__/a4-guard-sweep-head-logins.txt`). The member list's HEADs
 * have its logins too, but the member guard reads the row's scope, not its
 * logins: no cell of theirs changed.
 */
const HEAD_LOGIN_ROWS: ReadonlySet<string> = new Set(
  [...ANY_LOGIN_ROUTES, ...CHAT_LOGIN_ROUTES, ...TELEGRAM_LOGIN_ROUTES]
    .filter((k) => k.startsWith('GET '))
    .map((k) => k.replace(/^GET /, 'HEAD ')),
);
const headLoginCells = new Map<string, string>();
/**
 * The guard writes (A4 step 3b part 5 fix round 1): every cell of a write
 * (auditsAsWrite) a guard or the pipeline answered, keyed by the sweep, the
 * cell and the guard names its entries stand for (a moved entry under the
 * guard it replaced, as in the recorded files), to what the request wrote
 * on the side: its audit rows (the any-login row included: workspaceCaller(),
 * POST /api/auth/pair, the any-login answer step) and the create home the
 * request noted. `moved`: its entry is the pipeline's.
 */
const guardWrites = new Map<string, { side: string; moved: boolean }>();
const GUARD_NAMES: ReadonlySet<string> = new Set(SESSION_GUARDS);
function noteGuardWrite(sweep: string, cell: string): void {
  const names = sweepState.log
    .map((l) => l.split(' ')[0]!)
    .filter((n) => GUARD_NAMES.has(n) || LEGACY_NAMES[n]);
  if (names.length === 0) return;
  const [method = '', pattern = ''] = cell.split(' ');
  if (!auditsAsWrite(method, isReadRequest(method, pattern) ? 'read' : 'write')) return;
  guardWrites.set(`${sweep} ${cell} ${names.map((n) => LEGACY_NAMES[n] ?? n).join(',')}`, {
    side: `audits=${JSON.stringify(sweepState.audits)} home=${sweepState.noted ?? '-'}`,
    moved: names.some((n) => n.startsWith('pipeline:')),
  });
}
function noteMoved(sweep: string, cell: string, answer: string): string {
  noteGuardWrite(sweep, cell);
  const row = cell.split(' ').slice(0, 2).join(' ');
  if (OWNER_DECISION_ROWS.has(row)) ownerDecision.set(`${sweep} ${cell}`, answer);
  if (RULE_IN_QUERY_ROWS.has(row)) ruleInQueryCells.set(`${sweep} ${cell}`, legacy(answer));
  if (HEAD_LOGIN_ROWS.has(row)) headLoginCells.set(`${sweep} ${cell}`, legacy(answer));
  if (answer.includes('[pipeline:')) {
    moved.set(`${sweep} ${cell}`, answer);
    const [method = '', pattern = ''] = cell.split(' ');
    if (auditsAsWrite(method, isReadRequest(method, pattern) ? 'read' : 'write')) {
      movedWrites.set(
        `${sweep} ${cell}`,
        `audits=${JSON.stringify(sweepState.audits)} home=${sweepState.home ?? '-'}`,
      );
    }
  }
  return legacy(answer);
}

/** An answer with the actor and the request outcome the sweep notes after
 *  a guard's or the pipeline's answer masked (`actor=… out=…`): what the
 *  owner decisions 1a and 2a changed, and nothing else may. */
function maskActor(answer: string): string {
  return answer.replace(/\bactor=\S+ out=[^\]\s]+/g, 'actor=* out=*');
}

/** A main answer as the gate answers it since A10 #15: an /api answer
 *  that named no Cache-Control answers `no-store` (the gate's default,
 *  apiCacheDefault). Every cell of these files is an /api route; the
 *  header follows the content type, as the sweep writes it. */
function withGateCacheDefault(answer: string): string {
  return / cache-control=/.test(answer.split(' {')[0]!.split(' [')[0]!)
    ? answer
    : answer.replace(/^(\d{3} content-type=\S+)/, '$1 cache-control=no-store');
}

/** The header of the main answers in a decision file (decisionFile). */
const MAIN_ANSWERS = '# answers on main';

/**
 * A decision file of A4 hand batch A (the owner decisions 1a and 2a,
 * docs/actors.md): every cell of the decided rows (`cells`, sweep and cell
 * to its answer as the recorded files spell it), and, kept beside each, its
 * answer on main before the change (`main=`). The main answers are written
 * by hand once and read back from the file on every run, never taken from
 * the run: the test holds the set of cells to the set kept, and each
 * cell's answer to its main answer with the actor and the request outcome
 * masked (maskActor), BEFORE it compares the file. So a rerun with `-u`
 * records the cells as driven but cannot accept a changed status, header,
 * body or log line on these rows: the check fails first, and the main
 * answers are carried over as they were.
 */
async function decisionFile(
  file: string,
  cells: ReadonlyMap<string, string>,
  prefix: string,
  header: readonly string[],
): Promise<void> {
  expect(cells.size, file).toBeGreaterThan(0);
  const path = join(here, '__snapshots__', file);
  const kept = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  const mainTable = new Map<string, string>();
  const mainOf = new Map<string, string>();
  let inMain = false;
  for (const line of kept) {
    if (line.startsWith(MAIN_ANSWERS)) {
      inMain = true;
      continue;
    }
    if (inMain && line.startsWith('#')) continue;
    if (line === '') inMain = false;
    const answer = inMain ? /^(o\d+) (.*)$/.exec(line) : null;
    if (answer) mainTable.set(answer[1]!, answer[2]!);
    const cell = /^(\S+ \S+ \S+ \S+)=\w+ main=(o\d+)$/.exec(line);
    if (cell) {
      const main = mainTable.get(cell[2]!);
      expect(main, `${file}: ${cell[1]} names a main answer the file does not keep`).toBeDefined();
      mainOf.set(cell[1]!, main!);
    }
  }
  // Every cell of the decided rows has its main answer kept, and no other.
  expect([...cells.keys()].sort(), `${file}: the cells kept with a main answer`).toEqual(
    [...mainOf.keys()].sort(),
  );
  // Each differs from main in the actor and the request outcome only (and
  // the gate's Cache-Control default, A10 #15).
  for (const [cell, answer] of cells) {
    expect(maskActor(answer), `${file}: ${cell} against its answer on main`).toBe(
      maskActor(withGateCacheDefault(mainOf.get(cell)!)),
    );
  }
  const ids = new Map<string, string>();
  const mainIds = new Map<string, string>();
  const idOf = (table: Map<string, string>, p: string, answer: string) => {
    let id = table.get(answer);
    if (!id) {
      id = `${p}${table.size + 1}`;
      table.set(answer, id);
    }
    return id;
  };
  const lines = [...cells].map(
    ([cell, answer]) =>
      `${cell}=${idOf(ids, prefix, answer)} main=${idOf(mainIds, 'o', mainOf.get(cell)!)}`,
  );
  await expect(
    [
      ...header,
      '# answers',
      ...[...ids].map(([answer, id]) => `${id} ${answer}`),
      '',
      `${MAIN_ANSWERS} (before the change; kept by hand: the sweep reads them back and holds`,
      '# each cell to its main answer with actor= and out= masked, so a -u rerun cannot',
      '# accept any other change on these rows)',
      ...[...mainIds].map(([answer, id]) => `${id} ${answer}`),
      '',
      `# cells: ${cells.size}`,
      ...lines,
      '',
    ].join('\n'),
  ).toMatchFileSnapshot(`./__snapshots__/${file}`);
}

/** The headers a client reads. */
const HEADERS = [
  'content-type',
  'cache-control',
  'location',
  'vary',
  'access-control-allow-origin',
  'retry-after',
  'www-authenticate',
];

describe.skipIf(!hasManifest)('A4 step 3a: every guard answers as on main', () => {
  const saved = {
    secret: process.env.SESSION_SECRET,
    cors: process.env.MANTLE_API_CORS_ORIGINS,
    detached: process.env.MANTLE_DETACHED_DEV,
  };
  let app: import('hono').Hono;
  let rows: Array<{ pattern: string; methods: string[] }>;
  let creds: Cred[];
  let moreCreds: Cred[];

  beforeAll(async () => {
    process.env.SESSION_SECRET = 'a4-guard-sweep-secret-that-is-at-least-32-chars';
    delete process.env.MANTLE_API_CORS_ORIGINS;
    delete process.env.MANTLE_DETACHED_DEV;
    const tokens = await import('../lib/auth/tokens');
    const ttl = 30 * 24 * 60 * 60;
    const cookie = (id: string) => ({
      cookie: `${SESSION_COOKIE_NAME}=${tokens.buildSessionCookie(id, { ttlSeconds: ttl }).value}`,
    });
    let n = 0;
    const bearer = (
      id: string,
      revoked = false,
      row: { rotatedTo?: string; expiresAt?: Date } = {},
    ) => {
      n += 1;
      const jti = `0000000${n}-0000-4000-8000-00000000000${n}`;
      const t = tokens.buildMobileToken(id, jti, ttl, 0);
      sweepState.bearers.set(jti, {
        userId: id,
        revokedAt: revoked ? new Date() : null,
        expiresAt: row.expiresAt ?? t.expiresAt,
        rotatedTo: row.rotatedTo ?? null,
      });
      return { authorization: `Bearer ${t.value}` };
    };
    const key = (token: string) => ({ authorization: `Bearer ${token}` });
    creds = [
      { name: 'none', headers: {} },
      { name: 'owner-cookie', headers: cookie(ANCHOR_ID) },
      { name: 'admin-cookie', headers: cookie(ADMIN_ID) },
      { name: 'limited-cookie', headers: cookie(LIMITED_ID) },
      { name: 'member-cookie', headers: cookie(MEMBER_ID) },
      { name: 'admin-bearer', headers: bearer(ADMIN_ID) },
      { name: 'member-bearer', headers: bearer(MEMBER_ID) },
      { name: 'revoked-bearer', headers: bearer(ADMIN_ID, true) },
      { name: 'key-read', headers: key(KEY_TOKENS.read) },
      { name: 'key-write', headers: key(KEY_TOKENS.write) },
      { name: 'key-read-area', headers: key(KEY_TOKENS.readArea) },
      { name: 'key-write-area', headers: key(KEY_TOKENS.writeArea) },
      { name: 'key-member', headers: key(KEY_TOKENS.member) },
      {
        name: 'asset-admin',
        headers: {},
        query: `at=${encodeURIComponent(tokens.buildAssetToken(ANCHOR_ID, ADMIN_ID))}`,
        getOnly: true,
      },
      {
        name: 'asset-member',
        headers: {},
        query: `at=${encodeURIComponent(tokens.buildAssetToken(ANCHOR_ID, MEMBER_ID))}`,
        getOnly: true,
      },
      {
        name: 'render',
        headers: {
          cookie: `${RENDER_COOKIE_NAME}=${tokens.buildRenderToken({
            ownerId: ANCHOR_ID,
            actorId: ADMIN_ID,
            nodeId: NODE_ID,
          })}`,
        },
        getOnly: true,
      },
      {
        name: 'frame-ticket',
        headers: {},
        query: `t=${encodeURIComponent(tokens.buildAppFrameTicket({ ownerId: ANCHOR_ID, appId: NODE_ID, actorId: ADMIN_ID }))}`,
        getOnly: true,
      },
    ];
    // The more-credentials sweep's (made after the first sweep's, so its
    // device tokens keep their ids).
    moreCreds = [
      { name: 'disabled-cookie', headers: cookie(DISABLED_ID) },
      { name: 'bumped-cookie', headers: cookie(BUMPED_ID) },
      { name: 'gone-cookie', headers: cookie(GONE_ID) },
      {
        name: 'rotated-bearer',
        headers: bearer(ADMIN_ID, true, { rotatedTo: '00000009-0000-4000-8000-000000000009' }),
      },
      { name: 'expired-bearer', headers: bearer(MEMBER_ID, false, { expiresAt: new Date(0) }) },
      { name: 'key-unknown', headers: key(KEY_TOKENS.unknown) },
      { name: 'key-revoked', headers: key(KEY_TOKENS.revoked) },
    ];
    const { createApp } = await import('./app');
    app = await createApp();
    const { routeManifest } = await import('./route-manifest.gen');
    const [{ SHARE_PAGES }, { PRINT_PAGES }] = await Promise.all([
      import('./pages/share'),
      import('./pages/print'),
    ]);
    rows = [
      ...routeManifest.map((e) => ({ pattern: e.pattern, methods: [...e.methods] })),
      ...[...SHARE_PAGES, ...PRINT_PAGES].map((p) => ({
        pattern: p.pattern,
        methods: [...p.methods],
      })),
    ].sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  }, 60_000);

  afterAll(() => {
    for (const [k, v] of [
      ['SESSION_SECRET', saved.secret],
      ['MANTLE_API_CORS_ORIGINS', saved.cors],
      ['MANTLE_DETACHED_DEV', saved.detached],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function drive(method: string, path: string, cred: Cred): Promise<string> {
    sweepState.log.length = 0;
    sweepState.audits.length = 0;
    sweepState.home = null;
    sweepState.noted = null;
    const url = cred.query ? `${path}${path.includes('?') ? '&' : '?'}${cred.query}` : path;
    const res = await app.request(url, {
      method,
      headers: { ...cred.headers, 'content-type': 'application/json' },
      body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
    });
    const parts = [String(res.status)];
    for (const h of HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) parts.push(`${h}=${h === 'location' ? v.replace(/\?.*$/, '?…') : v}`);
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      await res.body?.cancel().catch(() => undefined);
      parts.push('stream');
    } else {
      const text = await res.text();
      // A refusal's body, and a guarded answer's: what the guard sent. A
      // route no guard serves keeps its own body (a version, a page) out.
      if (type.includes('json') && (sweepState.log.length > 0 || res.status >= 400)) {
        parts.push(text.slice(0, 300));
      }
    }
    for (const line of sweepState.log) parts.push(`[${line}]`);
    return parts.join(' ');
  }

  it('answers every route, method and credential as recorded on main', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const answers = new Map<string, string>();
    const lines: string[] = [];
    let driven = 0;
    try {
      for (const row of rows) {
        const path = concretePath(row.pattern);
        const methods = row.methods.includes('GET') ? [...row.methods, 'HEAD'] : row.methods;
        for (const method of methods) {
          if (method === 'OPTIONS') continue;
          const cells: string[] = [];
          for (const cred of creds) {
            if (cred.getOnly && method !== 'GET') continue;
            const answer = noteMoved(
              'first',
              `${method} ${row.pattern} ${cred.name}`,
              await drive(method, path, cred),
            );
            driven += 1;
            let id = answers.get(answer);
            if (!id) {
              id = `a${answers.size + 1}`;
              answers.set(answer, id);
            }
            cells.push(`${cred.name}=${id}`);
          }
          lines.push(`${method} ${row.pattern}: ${cells.join(' ')}`);
        }
      }
    } finally {
      quiet.mockRestore();
      warn.mockRestore();
    }
    const table = [...answers].map(([answer, id]) => `${id} ${answer}`);
    expect(driven).toBeGreaterThan(10_000);
    await expect(
      ['# answers', ...table, '', '# routes', ...lines, ''].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a4-guard-sweep.txt');
  }, 1_200_000);

  /** Every route and method (OPTIONS aside), as the first sweep walks them. */
  function* cellsOf(
    list: Cred[],
  ): Generator<{ line: string; method: string; path: string; cred: Cred }> {
    for (const row of rows) {
      const path = concretePath(row.pattern);
      const methods = row.methods.includes('GET') ? [...row.methods, 'HEAD'] : row.methods;
      for (const method of methods) {
        if (method === 'OPTIONS') continue;
        for (const cred of list) {
          if (cred.getOnly && method !== 'GET') continue;
          yield { line: `${method} ${row.pattern}`, method, path, cred };
        }
      }
    }
  }

  it('answers more credentials, and the cells that wanted a database, as recorded on main', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const answers = new Map<string, string>();
    const idOf = (answer: string) => {
      let id = answers.get(answer);
      if (!id) {
        id = `a${answers.size + 1}`;
        answers.set(answer, id);
      }
      return id;
    };
    const more = new Map<string, string[]>();
    const again = new Map<string, string[]>();
    const NO_DB = 'DATABASE_URL must be set';
    let noDbBefore = 0;
    let noDbAfter = 0;
    // The clock stands still, hours past the first sweep's rate-limit
    // windows: every limit this sweep meets starts empty and answers the
    // same Retry-After, whichever sweep ran first.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
    try {
      sweepState.reads = true;
      for (const { line, method, path, cred } of cellsOf(moreCreds)) {
        const answer = noteMoved('more', `${line} ${cred.name}`, await drive(method, path, cred));
        if (answer.includes(NO_DB)) noDbAfter += 1;
        more.set(line, [...(more.get(line) ?? []), `${cred.name}=${idOf(answer)}`]);
      }
      // The first sweep's cells where a guard threw for want of a
      // database, driven again with the reads stood in.
      for (const { line, method, path, cred } of cellsOf(creds)) {
        sweepState.reads = false;
        const before = await drive(method, path, cred);
        if (!before.includes(NO_DB)) continue;
        noDbBefore += 1;
        sweepState.reads = true;
        const answer = noteMoved('again', `${line} ${cred.name}`, await drive(method, path, cred));
        if (answer.includes(NO_DB)) noDbAfter += 1;
        again.set(line, [...(again.get(line) ?? []), `${cred.name}=${idOf(answer)}`]);
      }
    } finally {
      vi.useRealTimers();
      sweepState.reads = false;
      quiet.mockRestore();
      warn.mockRestore();
    }
    const table = [...answers].map(([answer, id]) => `${id} ${answer}`);
    const lines = (m: Map<string, string[]>) =>
      [...m].map(([l, cells]) => `${l}: ${cells.join(' ')}`);
    expect(more.size).toBeGreaterThan(500);
    await expect(
      [
        '# answers',
        ...table,
        '',
        `# cells that wanted a database: ${noDbBefore} in the first sweep; ${noDbAfter} still do with the reads stood in`,
        '',
        '# more credentials',
        ...lines(more),
        '',
        '# the first sweep, its cells that wanted a database, with the reads stood in',
        ...lines(again),
        '',
      ].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a4-guard-sweep-more.txt');
  }, 1_200_000);

  it('records every guard entry that moved to the pipeline (A4 step 3b)', async () => {
    // After both sweeps (the tests of this file run in order). Each line is
    // a cell whose handler reads the caller the gate answered: its answer as
    // driven, the entry logged at the gate (pipeline:owner) where the guard's
    // was. The recorded files hold the same answer under the guard's name.
    expect(moved.size).toBeGreaterThan(0);
    const answers = new Map<string, string>();
    const lines = [...moved].map(([cell, answer]) => {
      let id = answers.get(answer);
      if (!id) {
        id = `m${answers.size + 1}`;
        answers.set(answer, id);
      }
      return `${cell}=${id}`;
    });
    await expect(
      [
        '# answers',
        ...[...answers].map(([answer, id]) => `${id} ${answer}`),
        '',
        `# cells whose guard entry moved to the pipeline: ${moved.size}`,
        ...lines,
        '',
      ].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a4-guard-sweep-moved.txt');
  });

  it('records the cells the owner decided on 2026-10-14 (A4 step 3b part 4)', async () => {
    // GET and HEAD /api/updates/status and POST /api/updates/check need the
    // settings area since the owner's decision: an Admin user without it is
    // refused (403 area), a member gets the gate's 403 member-login and no
    // login its 401, where the handler answered any Admin user and a 401
    // to the rest. The recorded files hold these cells as driven now; this
    // file names them, one line each, so the change is on the record.
    expect(ownerDecision.size).toBeGreaterThan(0);
    const answers = new Map<string, string>();
    const lines = [...ownerDecision].map(([cell, answer]) => {
      let id = answers.get(answer);
      if (!id) {
        id = `d${answers.size + 1}`;
        answers.set(answer, id);
      }
      return `${cell}=${id}`;
    });
    await expect(
      [
        '# the owner decision of 2026-10-14: GET and HEAD /api/updates/status and POST',
        '# /api/updates/check need the settings area (before: any Admin user; a member',
        "# and no login got the handler's 401). GET /api/updates/check stays open to",
        '# every Admin user (a carve-out). Every other cell is as recorded on main.',
        '# answers',
        ...[...answers].map(([answer, id]) => `${id} ${answer}`),
        '',
        `# cells: ${ownerDecision.size}`,
        ...lines,
        '',
      ].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a4-guard-sweep-owner-decision.txt');
  });

  it('records the cells of the any-login rows that leave the scope by name (the owner decision 1a, A4 hand batch A)', async () => {
    // GET /api/shell, GET /api/v1/whoami, GET, POST /api/access-keys and
    // DELETE /api/access-keys/:id (and the HEADs) read the login before the
    // exit since the owner's decision 1a: the actor noted after the login's
    // answer is the gate's (system:http:no-login for a refusal, the login
    // for a login let through), no longer system:rule-in-query. The
    // recorded files hold these cells as driven now; this file names them,
    // one line each, as the recorded files spell them, each held to its
    // answer on main (decisionFile).
    await decisionFile('a4-guard-sweep-rule-in-query.txt', ruleInQueryCells, 'q', [
      '# the owner decision of 2026-10-14, 1a: the any-login handlers of the four',
      '# ruleInQuery files read the login before they leave the request scope by name',
      "# (asSystem 'rule-in-query'). The actor noted after the login's answer was",
      '# system:rule-in-query (the guard ran inside the exit); the gate answers outside',
      '# it: a refusal is noted as system:http:no-login, a login let through as the',
      '# login. Status, headers, body and the request outcome are unchanged. Every',
      '# other cell is as recorded on main.',
    ]);
  });

  it("records the HEAD cells that take their GET's logins (the owner decision 2a, A4 hand batch A)", async () => {
    // The HEAD of each GET row of the any-login, chat and Telegram lists:
    // the login's answer runs under the login's own rule, as on its GET,
    // where it ran on the system pool (login-self). The recorded files hold
    // these cells as driven now; this file names them, one line each, as
    // the recorded files spell them, each held to its answer on main
    // (decisionFile).
    await decisionFile('a4-guard-sweep-head-logins.txt', headLoginCells, 'h', [
      "# the owner decision of 2026-10-14, 2a (open question M3): a HEAD row has its GET's",
      '# logins. The HEADs of the any-login, chat and Telegram GET rows ran the GET handler',
      '# on the system pool (login-self) for every login; they run under its own rule now,',
      '# as the GET does. Only the actor and the request outcome noted after the',
      "# login's answer changed; status, headers and body are as recorded. Every other",
      '# cell is as recorded on main.',
    ]);
  });

  it('records what each moved write did on the side (A4 step 3b part 4)', async () => {
    // A moved cell of a write: the audit rows the request wrote and the
    // create home the pipeline's answer named, so a write's side effects
    // are pinned per cell, at the gate where they now run. Its own file:
    // the recorded files and the moved file stay as they were.
    expect(movedWrites.size).toBeGreaterThan(0);
    const answers = new Map<string, string>();
    const lines = [...movedWrites].map(([cell, side]) => {
      let id = answers.get(side);
      if (!id) {
        id = `w${answers.size + 1}`;
        answers.set(side, id);
      }
      return `${cell}=${id}`;
    });
    await expect(
      [
        '# what a moved write did on the side: its audit rows, the create home named',
        ...[...answers].map(([side, id]) => `${id} ${side}`),
        '',
        `# moved cells of a write: ${movedWrites.size}`,
        ...lines,
        '',
      ].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a4-guard-sweep-moved-writes.txt');
  });

  it('holds what each guard write did on the side when its row moves (A4 step 3b part 5 fix round 1)', async () => {
    // The guard path's baseline: every cell of a write a guard still
    // answers, its audit rows and the create home noted, keyed by the guard
    // names (a4-guard-sweep-guard-writes.txt). A row that moves keeps its
    // cells here under the guard its reader replaced, now as the pipeline
    // drove them, and each must match the guard path's record: a lost or a
    // doubled audit row (the any-login row folded into the answer step) or
    // another create home fails here, by cell, before the file is
    // compared. The cells that moved before this file was recorded are in
    // the moved writes file only.
    const file = join(here, '__snapshots__/a4-guard-sweep-guard-writes.txt');
    const baseline = new Map<string, string>();
    if (existsSync(file)) {
      const sides = new Map<string, string>();
      let section = '';
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.startsWith('#')) section = line;
        else if (!line) continue;
        else if (section.startsWith('# what a guard write did')) {
          const at = line.indexOf(' ');
          sides.set(line.slice(0, at), line.slice(at + 1));
        } else {
          const at = line.lastIndexOf('=');
          baseline.set(line.slice(0, at), sides.get(line.slice(at + 1))!);
        }
      }
    }
    const kept = [...guardWrites].filter(([cell, w]) => !w.moved || baseline.has(cell));
    expect(kept.length).toBeGreaterThan(0);
    const now = new Map(kept.map(([cell, w]) => [cell, w.side]));
    const changed = [...baseline]
      .filter(([cell, side]) => now.get(cell) !== side)
      .map(([cell, side]) => `${cell}: guard path ${side}; now ${now.get(cell) ?? 'no such cell'}`);
    expect(changed).toEqual([]);
    const answers = new Map<string, string>();
    const lines = kept.map(([cell, w]) => {
      let id = answers.get(w.side);
      if (!id) {
        id = `g${answers.size + 1}`;
        answers.set(w.side, id);
      }
      return `${cell}=${id}`;
    });
    await expect(
      [
        '# what a guard write did on the side: its audit rows, the create home noted',
        ...[...answers].map(([side, id]) => `${id} ${side}`),
        '',
        `# cells of a write a guard answered (by its name; a moved one under the guard it replaced): ${kept.length}`,
        ...lines,
        '',
      ].join('\n'),
    ).toMatchFileSnapshot('./__snapshots__/a4-guard-sweep-guard-writes.txt');
  });
});
