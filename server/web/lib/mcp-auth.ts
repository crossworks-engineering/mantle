/**
 * Who is calling /api/mcp (MCP as a login, plan page e5b854dd).
 *
 * Four bearers resolve to one `McpCaller` (@mantle/mcp-core). The fourth,
 * an inbound API key (`mtlk_`), is `callerFromAccessKey` below. The others:
 *
 *  1. An OAuth access token (`mtlmcp_at_`): the login that consented. An
 *     admin's grant is the owner's connector, unchanged. A member's grant
 *     dies with the login's session epoch (actorMayConnect).
 *  2. A static login token (`mtlmcpk_`): minted by an admin for one member
 *     login, for an MCP client without OAuth. Same epoch rule. Minting is
 *     RETIRED (2026-10-07: nobody makes a credential for another login;
 *     each login makes its own API key), and migration 0268 revoked every
 *     token made before (W7b fix round 1): this path only refuses now.
 *  3. A peer token (`mtlpeer_`) whose peer is bound to a login: the peer
 *     acts as that login with the peer's own write switch. The login must
 *     still be usable and still hold the role it had when it was bound: a
 *     role change fails closed.
 *
 * Since workspaces W7b every login gets the one MCP surface in its own
 * scope (@mantle/mcp-core login-surface.ts): the per-login MCP switch
 * (mcp_login_access, archived by migration 0268) is gone, and a login
 * carries no permission of its own. A key's or a peer's write switch and
 * the risky-tool rule only narrow. A client login stays refused (no client
 * exists yet, plan 21.9).
 *
 * Every rule is read from the rows on every request, never from the token.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { authUsers, db, mcpLoginTokens, resolveSingleOwnerId } from '@mantle/db';
import { PEER_TOKEN_PREFIX, verifyInboundToken } from '@mantle/content';
import { isMcpToolReadOnly, type McpCaller, type McpLoginRole } from '@mantle/mcp-core';
import { bearerFrom } from './auth/request';
import {
  auditKeyRefusal,
  countFailedKey,
  failedKeyBudget,
  isAccessKey,
  touchAccessKey,
  verifyAccessKey,
} from './access-keys';
import { auditFireAndForget, requestMetaFrom } from './audit';
import {
  BodyTooLargeError,
  JSON_BODY_CEILING_BYTES,
  OWNER_DOCUMENT_CEILING_BYTES,
  readBodyCapped,
} from './body-limit';
import { actorMayConnect, grantFromAccessToken } from './mcp-oauth';
import { clientIp, clientIpKey } from './rate-limit';

/** The static login token's prefix. */
export const MCP_LOGIN_TOKEN_PREFIX = 'mtlmcpk_';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

type LoginRow = {
  id: string;
  role: string;
  email: string | null;
  displayName: string | null;
  disabledAt: Date | null;
  sessionEpoch: number;
};

async function loadLogin(loginId: string): Promise<LoginRow | null> {
  const [row] = await db
    .select({
      id: authUsers.id,
      role: authUsers.role,
      email: authUsers.email,
      displayName: authUsers.displayName,
      disabledAt: authUsers.disabledAt,
      sessionEpoch: authUsers.sessionEpoch,
    })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  return row ?? null;
}

function isRole(v: string): v is McpLoginRole {
  return v === 'admin' || v === 'member' || v === 'client';
}

/** A member's or client's caller from its login row, or null. Its writes
 *  are whatever its scope may write (W7b: no per-login switch); a client
 *  caller is refused by the surface (prepareCallerTools). */
function loginCaller(
  row: LoginRow,
  anchorId: string,
  via: 'oauth' | 'token',
  oauthClientId?: string,
  /** The grant was narrowed to read-only (0268, MCP_READ_ONLY_SCOPE). */
  readOnly = false,
): McpCaller | null {
  if (row.role !== 'member' && row.role !== 'client') return null;
  if (row.disabledAt || !row.email) return null;
  return {
    role: row.role,
    anchorId,
    loginId: row.id,
    displayName: row.displayName,
    via,
    write: !readOnly,
    ...(oauthClientId ? { oauthClientId } : {}),
  };
}

/** Resolve the caller from the request's bearer, or null (answer 401). */
export async function resolveMcpCaller(req: Request): Promise<McpCaller | null> {
  const token = bearerFrom(req);
  if (!token) return null;

  if (token.startsWith(PEER_TOKEN_PREFIX)) return callerFromPeerToken(token);
  if (token.startsWith(MCP_LOGIN_TOKEN_PREFIX)) return callerFromLoginToken(token);
  if (isAccessKey(token)) return callerFromAccessKey(req, token);

  const grant = await grantFromAccessToken(token);
  if (!grant) return null;
  if (!(await actorMayConnect(grant.actorId, grant.sessionEpoch))) return null;
  if (grant.sessionEpoch === null) {
    // An admin's grant: the owner's connector, as before 0227.
    return {
      role: 'admin',
      anchorId: grant.ownerId,
      loginId: grant.actorId,
      via: 'oauth',
      write: !grant.readOnly,
    };
  }
  const row = await loadLogin(grant.actorId);
  return row ? loginCaller(row, grant.ownerId, 'oauth', grant.clientId, grant.readOnly) : null;
}

async function callerFromLoginToken(token: string): Promise<McpCaller | null> {
  const [tok] = await db
    .select({
      id: mcpLoginTokens.id,
      loginId: mcpLoginTokens.loginId,
      sessionEpoch: mcpLoginTokens.sessionEpoch,
    })
    .from(mcpLoginTokens)
    .where(and(eq(mcpLoginTokens.tokenHash, sha256Hex(token)), isNull(mcpLoginTokens.revokedAt)))
    .limit(1);
  if (!tok) return null;
  const row = await loadLogin(tok.loginId);
  if (!row || row.sessionEpoch !== tok.sessionEpoch) return null;
  const anchorId = await resolveSingleOwnerId();
  if (!anchorId) return null;
  const caller = loginCaller(row, anchorId, 'token');
  if (!caller) return null;
  void db
    .update(mcpLoginTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(mcpLoginTokens.id, tok.id))
    .catch(() => {});
  return caller;
}

/**
 * An inbound API key (`mtlk_`, migration 0232): it acts as its login (that
 * login's workspaces, workspaces plan 7.5) and only narrows it: the one MCP
 * surface in the login's scope, held to the key's write switch, its risky
 * tools and its areas (W7b: a member key as an admin key). An `api_only`
 * key (0268) is refused here and works on /api/v1 only.
 * A refused key is a 401 like any bad bearer; the failed try counts
 * against the caller's address, as on /api/v1.
 */
async function callerFromAccessKey(req: Request, token: string): Promise<McpCaller | null> {
  const ip = clientIp(req);
  const ipKey = clientIpKey(req);
  if (!failedKeyBudget(ipKey, token).ok) return null;
  const check = await verifyAccessKey(token);
  if (!check.ok) {
    countFailedKey(ipKey, token);
    if (check.keyId) {
      auditKeyRefusal({
        keyId: check.keyId,
        reason: check.reason,
        method: req.method,
        path: '/api/mcp',
        ...requestMetaFrom(req),
      });
    }
    return null;
  }
  const key = check.grant;
  // A key made for /api/v1 by a login that never had MCP (0268, W7b fix
  // round 2): it keeps working there and never reaches MCP. Refused like a
  // bad bearer, but not counted as a failed try (the key is real).
  if (key.apiOnly) {
    auditKeyRefusal({
      keyId: key.id,
      reason: 'api_only',
      method: req.method,
      path: '/api/mcp',
      ...requestMetaFrom(req),
    });
    return null;
  }
  const anchorId = await resolveSingleOwnerId();
  if (!anchorId) return null;
  const keyWrite = key.access === 'read_write';
  let caller: McpCaller | null;
  if (key.role === 'admin') {
    caller = {
      role: 'admin',
      anchorId,
      loginId: key.loginId,
      displayName: key.login.displayName,
      via: 'key',
      write: keyWrite,
      riskyAllowed: key.riskyTools,
    };
  } else {
    const row = await loadLogin(key.loginId);
    const login = row ? loginCaller(row, anchorId, 'token') : null;
    caller = login
      ? { ...login, via: 'key', write: keyWrite, riskyAllowed: key.riskyTools ?? [] }
      : null;
  }
  if (!caller) return null;
  touchAccessKey(key.id, ip);
  const out: McpCaller = { ...caller, keyId: key.id, areas: key.areas };
  keyCallers.set(out, { email: key.login.email, createdBy: key.createdBy });
  return out;
}

/** Who a key caller is, for its audit rows (the caller type stays lean). */
const keyCallers = new WeakMap<McpCaller, { email: string; createdBy: string | null }>();

/**
 * One `api.write` row per write tool call an API key makes on /api/mcp (M2
 * audit F6), as /api/v1 writes leave one: the tool, the key and its maker.
 * Read-only tools leave none, and so does a call the key may not make
 * (`allows`: the tools this caller was given; M2 audit N6), which the MCP
 * server refuses as an unknown tool. Reads a clone of the whole JSON-RPC
 * body (a single message or a batch; the route's body limit bounds it), so
 * padding cannot hide the tool name. A body that is not JSON is the
 * transport's to refuse. Never blocks the call.
 */
export async function auditMcpKeyCall(
  req: Request,
  caller: McpCaller,
  allows: (slug: string) => boolean,
): Promise<void> {
  const who = keyCallers.get(caller);
  if (!caller.keyId || !who || req.method !== 'POST') return;
  const meta = { ...requestMetaFrom(req), method: 'MCP', path: '/api/mcp' };
  // A capped read (final audit F4): a chunked body carries no length, so the
  // route's ceiling bounds what is buffered here. Over it, the call is
  // refused anyway (413 from the route), so there is nothing to audit.
  let body: unknown;
  try {
    // The route's own rule: a body may be an owner document (a file upload,
    // the one surface, W7b); a client's is held to the plain JSON ceiling.
    const ceiling =
      caller.role === 'client' ? JSON_BODY_CEILING_BYTES : OWNER_DOCUMENT_CEILING_BYTES;
    body = JSON.parse(await readBodyCapped(req.clone(), ceiling));
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    return;
  }
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { method?: unknown; params?: { name?: unknown } };
    const tool = typeof msg.params?.name === 'string' ? msg.params.name : null;
    if (msg.method !== 'tools/call' || !tool || isMcpToolReadOnly(tool) || !allows(tool)) continue;
    auditFireAndForget({
      actorId: caller.loginId,
      actorEmail: who.email,
      action: 'api.write',
      ...meta,
      detail: { keyId: caller.keyId, keyCreatedBy: who.createdBy, tool: tool.slice(0, 100) },
    });
  }
}

async function callerFromPeerToken(token: string): Promise<McpCaller | null> {
  const peer = await verifyInboundToken(token);
  if (!peer || !peer.actsAsLoginId || !peer.actsAsRole) return null;
  const row = await loadLogin(peer.actsAsLoginId);
  if (!row || row.disabledAt || !row.email) return null;
  if (!isRole(row.role) || row.role !== peer.actsAsRole) return null;
  // A linked brain acts as the login it is bound to (workspaces plan 7.6):
  // it reads that login's workspaces, and only narrows it, with its own
  // write switch and the risky-tool rule (the tools named on it; a peer
  // bound to a member names none). No per-login switch since W7b.
  return {
    role: row.role,
    anchorId: peer.ownerId,
    loginId: row.id,
    displayName: row.displayName,
    via: 'peer',
    peerId: peer.id,
    // The owner's own peer: bound to the anchor login and made by it.
    peerByOwner: row.role === 'admin' && row.id === peer.ownerId && peer.createdBy === peer.ownerId,
    write: peer.writeEnabled,
    riskyAllowed: row.role === 'admin' ? (peer.allowedRiskyTools ?? []) : [],
  };
}

// ── The OAuth consent and the token check ───────────────────────────────────

/** Whether this member login may connect an MCP client now (W7b: any
 *  usable member; a client login never, plan 21.9). */
export async function mcpLoginEnabled(loginId: string): Promise<boolean> {
  const row = await loadLogin(loginId);
  return !!row && row.role === 'member' && !row.disabledAt && !!row.email;
}

/** A member or client login by id (the consent route checks it first). */
export async function mcpTargetLogin(
  loginId: string,
): Promise<{ id: string; role: 'member' | 'client'; sessionEpoch: number } | null> {
  const row = await loadLogin(loginId);
  if (!row || (row.role !== 'member' && row.role !== 'client')) return null;
  return { id: row.id, role: row.role, sessionEpoch: row.sessionEpoch };
}
