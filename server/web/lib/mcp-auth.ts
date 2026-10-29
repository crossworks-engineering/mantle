/**
 * Who is calling /api/mcp (MCP as a login, docs/mcp-as-a-login.md).
 *
 * Three bearers resolve to one `McpCaller` (@mantle/mcp-core):
 *
 *  1. An OAuth access token (`mtlmcp_at_`): the login that consented. An
 *     admin's grant is the owner's connector, unchanged. A member's grant
 *     dies with the login's session epoch (actorMayConnect).
 *  2. A peer token (`mtlpeer_`) whose peer is bound to a login: the peer
 *     acts as that login, as the login is now, in its workspaces, with the
 *     peer's own write switch. The login must still be usable.
 *  3. An inbound API key (`mtlk_`): `callerFromAccessKey` below.
 *
 * A static login token (`mtlmcpk_`, revoked by 0268, its table dropped by
 * 0272) is no credential at all.
 *
 * Every login gets the one MCP surface in its own scope (@mantle/mcp-core
 * login-surface.ts), and a login carries nothing: no client role, no role
 * kept on a key or a peer. A key's or a
 * peer's write switch and the risky-tool rule only narrow.
 *
 * Every rule is read from the rows on every request, never from the token.
 */
import { eq } from 'drizzle-orm';
import { authUsers, db, resolveSingleOwnerId } from '@mantle/db';
import { PEER_TOKEN_PREFIX, verifyInboundToken } from '@mantle/content';
import { mcpToolPolicyOf, type McpCaller } from '@mantle/mcp-core';
import { isLoginRole } from '@mantle/client-types/role-names';
import { bearerFrom } from './auth/request';
import { loadLoginRow } from './auth/login-row';
import { loginIsAdmin } from './auth/admin-seat';
import { adminLogin, memberLogin } from './auth/session';
import {
  auditKeyRefusal,
  countFailedKey,
  failedKeyBudget,
  isAccessKey,
  touchAccessKey,
  verifyAccessKey,
} from './access-keys';
import { auditFireAndForget, requestMetaFrom } from './audit';
import { BodyTooLargeError, OWNER_DOCUMENT_CEILING_BYTES, readBodyCapped } from './body-limit';
import { actorMayConnect, grantFromAccessToken } from './mcp-oauth';
import { clientIp, clientIpKey } from './rate-limit';

type LoginRow = {
  id: string;
  /** A user of the live Admin workspace now, the login enabled
   *  (loginIsAdmin, read with the row): adminLogin's answer. */
  adminMember: boolean;
  email: string | null;
  displayName: string | null;
  disabledAt: Date | null;
  sessionEpoch: number;
};

async function loadLogin(loginId: string): Promise<LoginRow | null> {
  const [row] = await db
    .select({
      id: authUsers.id,
      adminMember: loginIsAdmin(loginId),
      email: authUsers.email,
      displayName: authUsers.displayName,
      disabledAt: authUsers.disabledAt,
      sessionEpoch: authUsers.sessionEpoch,
    })
    .from(authUsers)
    .where(eq(authUsers.id, loginId))
    .limit(1);
  return row ? { ...row, adminMember: row.adminMember === true } : null;
}

/** A member's caller from its login row (memberLogin), or null. Its writes
 *  are whatever its scope may write (there is no per-login switch). */
function memberMcpCaller(
  row: LoginRow,
  anchorId: string,
  via: 'oauth' | 'key',
  oauthClientId?: string,
  /** The grant was narrowed to read-only (0268, MCP_READ_ONLY_SCOPE). */
  readOnly = false,
): McpCaller | null {
  if (!memberLogin(row)) return null;
  return {
    role: 'member',
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
  if (isAccessKey(token)) return callerFromAccessKey(req, token);

  const grant = await grantFromAccessToken(token);
  if (!grant) return null;
  if (!(await actorMayConnect(grant.actorId, grant.sessionEpoch))) return null;
  if (grant.sessionEpoch === null) {
    // An admin's grant: the owner's connector, as before 0227. Its OAuth
    // client too: a messenger message names the credential it came through,
    // and messenger_wait skips the caller's own (Messenger V1, plan 20.3).
    return {
      role: 'admin',
      anchorId: grant.ownerId,
      loginId: grant.actorId,
      via: 'oauth',
      write: !grant.readOnly,
      oauthClientId: grant.clientId,
    };
  }
  const row = await loadLogin(grant.actorId);
  return row ? memberMcpCaller(row, grant.ownerId, 'oauth', grant.clientId, grant.readOnly) : null;
}

/**
 * An inbound API key (`mtlk_`, migration 0232): it acts as its login (that
 * login's workspaces, workspaces plan 7.5) and only narrows it: the one MCP
 * surface in the login's scope, held to the key's write switch, its risky
 * tools and its areas (a member key as an admin key). An `api_only`
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
  // A key made for /api/v1 by a login that never had MCP (0268): it keeps
  // working there and never reaches MCP. Refused like a
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
  // The key acts as its login as the login is now (no role is kept on the
  // key; verifyAccessKey read the row). An Admin login is a user of Admin
  // (adminLogin, read with the row); any other login takes the member path, which serves a member only.
  if (adminLogin(key.login)) {
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
    const login = row ? memberMcpCaller(row, anchorId, 'key') : null;
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
 * One `api.write` row per write tool call an API key makes on /api/mcp, as
 * /api/v1 writes leave one: the tool, the key and its maker. Read-only
 * tools leave none, and so does a call the key may not make (`allows`: the
 * tools this caller was given), which the MCP
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
  // A capped read: a chunked body carries no length, so the
  // route's ceiling bounds what is buffered here. Over it, the call is
  // refused anyway (413 from the route), so there is nothing to audit.
  let body: unknown;
  try {
    // The route's own rule: a body may be an owner document (a file upload,
    // the one surface).
    body = JSON.parse(await readBodyCapped(req.clone(), OWNER_DOCUMENT_CEILING_BYTES));
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw err;
    return;
  }
  const messages = Array.isArray(body) ? body : [body];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { method?: unknown; params?: { name?: unknown } };
    const tool = typeof msg.params?.name === 'string' ? msg.params.name : null;
    // A read (its policy's effect) leaves no write audit; a name
    // with no policy (a connector's tool) is audited as a write.
    if (msg.method !== 'tools/call' || !tool || mcpToolPolicyOf(tool)?.effect === 'read') continue;
    if (!allows(tool)) continue;
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
  if (!peer || !peer.actsAsLoginId) return null;
  // The login row with its Admin pair (loadLoginRow: membership of Admin
  // read with the row), so what only an Admin login has asks adminLogin.
  const row = await loadLoginRow(peer.actsAsLoginId);
  if (!row || row.disabledAt || !row.email) return null;
  // A role this code does not know is no login (fail closed).
  if (!isLoginRole(row.role)) return null;
  // A linked brain acts as the login it is bound to, as that login is now
  // (no role is kept on the peer): it reads that login's workspaces, and
  // only narrows it, with its own write switch and the risky-tool rule (the
  // tools named on it, for a peer bound to an admin login; the admin gate
  // still decides each call). There is no per-login switch.
  return {
    role: row.role,
    anchorId: peer.ownerId,
    loginId: row.id,
    displayName: row.displayName,
    via: 'peer',
    peerId: peer.id,
    // The owner's own peer: bound to the anchor login and made by it.
    peerByOwner: adminLogin(row) && row.id === peer.ownerId && peer.createdBy === peer.ownerId,
    write: peer.writeEnabled,
    riskyAllowed: adminLogin(row) ? (peer.allowedRiskyTools ?? []) : [],
  };
}

// ── The OAuth consent and the token check ───────────────────────────────────

/** A member login by id (memberLogin: usable, not an Admin user), or null.
 *  The consent route asks it on its member path. */
export async function mcpTargetLogin(
  loginId: string,
): Promise<{ id: string; role: 'member'; sessionEpoch: number } | null> {
  const row = await loadLogin(loginId);
  if (!row || !memberLogin(row)) return null;
  return { id: row.id, role: 'member', sessionEpoch: row.sessionEpoch };
}
