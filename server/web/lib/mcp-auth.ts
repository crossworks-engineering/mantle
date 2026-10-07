/**
 * Who is calling /api/mcp (MCP as a login, plan page e5b854dd).
 *
 * Four bearers resolve to one `McpCaller` (@mantle/mcp-core). The fourth,
 * an inbound API key (`mtlk_`), is `callerFromAccessKey` below. The others:
 *
 *  1. An OAuth access token (`mtlmcp_at_`): the login that consented. An
 *     admin's grant is the owner's connector, unchanged. A member's or
 *     client's grant needs the admin's per-login MCP switch, and dies with
 *     the login's session epoch (actorMayConnect).
 *  2. A static login token (`mtlmcpk_`): minted by an admin for one member
 *     or client login, for an MCP client without OAuth. Same switch, same
 *     epoch rule.
 *  3. A peer token (`mtlpeer_`) whose peer is bound to a login: the peer
 *     acts as that login (owner, member or client) with the peer's own write
 *     switch. The login must still be usable and still hold the role it had
 *     when it was bound: a role change fails closed.
 *
 * Every rule is read from the rows on every request, never from the token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { authUsers, db, mcpLoginAccess, mcpLoginTokens, resolveSingleOwnerId } from '@mantle/db';
import { PEER_TOKEN_PREFIX, verifyInboundToken } from '@mantle/content';
import type { McpCaller, McpLoginRole } from '@mantle/mcp-core';
import { bearerFrom } from './auth/request';
import {
  auditKeyRefusal,
  countFailedKey,
  failedKeyBudget,
  isAccessKey,
  touchAccessKey,
  verifyAccessKey,
} from './access-keys';
import { requestMetaFrom } from './audit';
import { actorMayConnect, grantFromAccessToken } from './mcp-oauth';
import { clientIp } from './rate-limit';

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
  mcpEnabled: boolean | null;
  mcpWrite: boolean | null;
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
      mcpEnabled: mcpLoginAccess.enabled,
      mcpWrite: mcpLoginAccess.writeEnabled,
    })
    .from(authUsers)
    .leftJoin(mcpLoginAccess, eq(mcpLoginAccess.loginId, authUsers.id))
    .where(eq(authUsers.id, loginId))
    .limit(1);
  return row ?? null;
}

function isRole(v: string): v is McpLoginRole {
  return v === 'admin' || v === 'member' || v === 'client';
}

/** A member's or client's caller from its login row, or null. */
function loginCaller(row: LoginRow, anchorId: string, via: 'oauth' | 'token'): McpCaller | null {
  if (row.role !== 'member' && row.role !== 'client') return null;
  if (row.disabledAt || !row.email || row.mcpEnabled !== true) return null;
  return {
    role: row.role,
    anchorId,
    loginId: row.id,
    displayName: row.displayName,
    via,
    write: row.mcpWrite === true,
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
      write: true,
    };
  }
  const row = await loadLogin(grant.actorId);
  return row ? loginCaller(row, grant.ownerId, 'oauth') : null;
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
 * An inbound API key (`mtlk_`, migration 0232): it acts as its login and
 * only narrows it. An admin key gets the owner tools held to the key's
 * write switch, its risky tools and its areas (as a peer bound to the
 * owner). A member or client key also needs the login's MCP switch on, and
 * writes only while both the key and the login's Write switch allow it.
 * A refused key is a 401 like any bad bearer; the failed try counts
 * against the caller's address, as on /api/v1.
 */
async function callerFromAccessKey(req: Request, token: string): Promise<McpCaller | null> {
  const ip = clientIp(req);
  if (!failedKeyBudget(ip).ok) return null;
  const check = await verifyAccessKey(token);
  if (!check.ok) {
    countFailedKey(ip);
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
    caller = login ? { ...login, via: 'key', write: login.write && keyWrite } : null;
  }
  if (!caller) return null;
  touchAccessKey(key.id, ip);
  return { ...caller, keyId: key.id, areas: key.areas };
}

async function callerFromPeerToken(token: string): Promise<McpCaller | null> {
  const peer = await verifyInboundToken(token);
  if (!peer || !peer.actsAsLoginId || !peer.actsAsRole) return null;
  const row = await loadLogin(peer.actsAsLoginId);
  if (!row || row.disabledAt || !row.email) return null;
  if (!isRole(row.role) || row.role !== peer.actsAsRole) return null;
  return {
    role: row.role,
    anchorId: peer.ownerId,
    loginId: row.id,
    displayName: row.displayName,
    via: 'peer',
    peerId: peer.id,
    write: peer.writeEnabled,
    riskyAllowed: row.role === 'admin' ? (peer.allowedRiskyTools ?? []) : [],
  };
}

// ── Admin side: the per-login switch and static tokens ───────────────────────

/** Whether this member or client login may connect an MCP client now. */
export async function mcpLoginEnabled(loginId: string): Promise<boolean> {
  const row = await loadLogin(loginId);
  return (
    !!row &&
    (row.role === 'member' || row.role === 'client') &&
    !row.disabledAt &&
    row.mcpEnabled === true
  );
}

/** A member or client login by id (the admin routes check it first). */
export async function mcpTargetLogin(
  loginId: string,
): Promise<{ id: string; role: 'member' | 'client'; sessionEpoch: number } | null> {
  const row = await loadLogin(loginId);
  if (!row || (row.role !== 'member' && row.role !== 'client')) return null;
  return { id: row.id, role: row.role, sessionEpoch: row.sessionEpoch };
}

/** Mint a static token for a member or client login. The plaintext is
 *  returned once; only its hash is kept. */
export async function mintMcpLoginToken(input: {
  loginId: string;
  sessionEpoch: number;
  label: string;
  createdBy: string;
}): Promise<{ id: string; token: string }> {
  const token = MCP_LOGIN_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const [row] = await db
    .insert(mcpLoginTokens)
    .values({
      loginId: input.loginId,
      label: input.label,
      tokenHash: sha256Hex(token),
      sessionEpoch: input.sessionEpoch,
      createdBy: input.createdBy,
    })
    .returning({ id: mcpLoginTokens.id });
  return { id: row!.id, token };
}
