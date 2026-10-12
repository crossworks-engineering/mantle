/**
 * Inbound API keys (plan page 1e62e204). Every login, signed in with a
 * session or a device token; a key itself can never reach this route (keys
 * work on /api/v1 and /api/mcp only).
 *
 * A key acts as the login that MADE it, and nothing else (Jason,
 * 2026-10-07, audit item 8): nobody can make a key that acts as another
 * login. It keeps no role of its own (workspaces W8a): it reads what its
 * login's workspaces read now.
 *
 * GET  /api/access-keys : the keys the caller may see (never the secret or
 *      its hash), the areas, the default and longest expiry, and the
 *      caller's kind. A member sees their own keys. An admin sees EVERY
 *      key, with its last-use address (audit item 4, decided): every admin
 *      already reads the audit log, addresses included, and must be able to
 *      find and revoke any key.
 * POST /api/access-keys { name, access, areas, expiresInDays?,
 *      riskyTools?, password? } : make a key for the caller's own login. The
 *      secret is in this answer ONCE. `areas` null = every area;
 *      `expiresInDays` omitted = the default, null = never. At most
 *      MAX_LIVE_KEYS_PER_LOGIN live keys per login, and 30 keys made per
 *      login an hour.
 *
 *      What a login may make is decided by its workspaces, never its role
 *      (W8a): "never", or more than 90 days (up to 3650), and risky tools,
 *      only for a login that holds the Admin workspace with its keys area;
 *      everyone else's key ends within 90 days and names no risky tool (the
 *      admin gate still decides each risky call). A stolen session must not
 *      be able to mint a key unseen (M2 audit F4): every login re-types its
 *      password (10 wrong tries a minute per login), and is told a key was
 *      made. A password change, "sign out everywhere" and an admin's End
 *      sessions revoke every key the login holds (endLoginSessions
 *      `endKeys`).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getLoginOr401, verifyPassword } from '@/lib/auth';
import {
  ACCESS_KEY_ACCESS,
  ACCESS_KEY_AREAS,
  DEFAULT_ACCESS_KEY_EXPIRY_DAYS,
  MAX_ACCESS_KEY_EXPIRY_DAYS,
  MAX_LIVE_KEYS_PER_LOGIN,
  expiryFromDays,
  maxKeyDays,
  mintAccessKey,
} from '@/lib/access-keys';
import { requireArea } from '@/lib/workspaces';
import { listAccessKeys } from '@/lib/access-keys-admin';
import { notifyKeyMade } from '@/lib/access-keys-notify';
import { rateLimitLogin, rateLimitLoginRefund } from '@/lib/rate-limit';
import { auditFireAndForget, requestMeta } from '@/lib/audit';
import { firstIssue } from '@/lib/zod-issue';
import type { AccessKeyCreated, AccessKeyList } from '@mantle/client-types';
import { ruleInQuery } from '@/lib/auth/rule-in-query';

const NO_STORE = { 'Cache-Control': 'no-store' };
/** Keys a login may make an hour (final audit F6): a make-and-revoke loop
 *  must not spam the login's notices and pushes. */
const CREATE_RATE = { max: 30, windowMs: 60 * 60_000 };
/** Wrong passwords a minute per login when making a key. */
const PASSWORD_RATE = { max: 10, windowMs: 60_000 };

const Body = z
  .object({
    name: z.string().trim().min(1, 'Name the key.').max(100),
    access: z.enum(ACCESS_KEY_ACCESS),
    areas: z.array(z.enum(ACCESS_KEY_AREAS)).min(1).max(ACCESS_KEY_AREAS.length).nullable(),
    expiresInDays: z.number().int().min(1).max(MAX_ACCESS_KEY_EXPIRY_DAYS).nullable().optional(),
    riskyTools: z
      .array(z.string().regex(/^[a-z0-9_]{1,64}$/, 'A tool slug.'))
      .max(50)
      .optional(),
    password: z.string().max(1000).optional(),
  })
  // A key is always the caller's own: a body that names a login is refused
  // rather than quietly ignored.
  .strict();

type Login = Exclude<Awaited<ReturnType<typeof getLoginOr401>>, Response>;

/** Whether the login holds the Admin workspace with its keys area now (W8a:
 *  what a key may be decides on this, never on the role). */
async function holdsKeysArea(login: Login): Promise<boolean> {
  return requireArea(
    {
      kind: login.kind,
      loginId: login.loginId,
      anchorId: login.kind === 'admin' ? login.user.id : login.member.anchorId,
      user: login.kind === 'admin' ? login.user : null,
    },
    'keys',
  );
}

async function handleGET() {
  const login = await getLoginOr401();
  if (login instanceof Response) return login;
  const keys = await listAccessKeys(login.kind === 'admin' ? null : login.loginId);
  const maxDays = maxKeyDays(await holdsKeysArea(login));
  return NextResponse.json(
    {
      keys,
      role: login.kind,
      areas: [...ACCESS_KEY_AREAS],
      defaultExpiryDays: Math.min(DEFAULT_ACCESS_KEY_EXPIRY_DAYS, maxDays ?? Infinity),
      maxExpiryDays: maxDays,
      // Every login re-types its password (kept on the wire for older apps).
      needsPassword: true,
    } satisfies AccessKeyList,
    { headers: NO_STORE },
  );
}

async function handlePOST(req: Request) {
  const login = await getLoginOr401();
  if (login instanceof Response) return login;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const body = parsed.data;
  const riskyTools = body.riskyTools ?? [];
  const keysArea = await holdsKeysArea(login);
  if (riskyTools.length > 0 && !keysArea) {
    return NextResponse.json(
      {
        error: 'Risky tools are for a key of a login in the Admin workspace with its keys area.',
        reason: 'risky-tools',
      },
      { status: 400 },
    );
  }
  const maxDays = maxKeyDays(keysArea);
  if (maxDays !== null) {
    if (body.expiresInDays === null || (body.expiresInDays ?? 0) > maxDays) {
      return NextResponse.json(
        { error: `Your keys can last at most ${maxDays} days.`, reason: 'expiry-too-long' },
        { status: 400 },
      );
    }
  }
  // Every try is counted BEFORE the password is checked, so parallel
  // guesses cannot all pass a peek (M2 audit N2); a right password gives
  // its token back, so making several keys is not guessing.
  const bucket = `akey-pw:${login.loginId}`;
  const tries = rateLimitLogin(bucket, PASSWORD_RATE);
  if (!tries.ok) {
    return NextResponse.json(
      { error: 'Too many tries. Wait a minute, then try again.' },
      { status: 429, headers: { 'Retry-After': String(tries.retryAfterSec) } },
    );
  }
  if (!body.password || !(await verifyPassword(login.loginId, body.password))) {
    return NextResponse.json(
      { error: 'Type your password to make a key.', reason: 'password' },
      { status: 403 },
    );
  }
  rateLimitLoginRefund(bucket);

  const made = rateLimitLogin(`akey-create:${login.loginId}`, CREATE_RATE);
  if (!made.ok) {
    return NextResponse.json(
      { error: 'You made many keys this hour. Wait, then try again.' },
      { status: 429, headers: { 'Retry-After': String(made.retryAfterSec) } },
    );
  }

  const expiresAt = expiryFromDays(
    body.expiresInDays === undefined && maxDays !== null
      ? Math.min(DEFAULT_ACCESS_KEY_EXPIRY_DAYS, maxDays)
      : body.expiresInDays,
  );
  const minted = await mintAccessKey({
    name: body.name,
    loginId: login.loginId,
    access: body.access,
    areas: body.areas,
    riskyTools,
    expiresAt,
    createdBy: login.loginId,
    maxLive: MAX_LIVE_KEYS_PER_LOGIN,
  });
  if (!minted) {
    return NextResponse.json(
      {
        error: `You have ${MAX_LIVE_KEYS_PER_LOGIN} keys. Revoke one you no longer use, then make a new one.`,
      },
      { status: 409 },
    );
  }
  const { id, prefix, key } = minted;

  // Tell the login a key was made on it (in-app, and a sealed push): a
  // stolen session must not make a key unseen. Not awaited: a slow push
  // relay must not hold the answer. Never the secret or the prefix.
  void notifyKeyMade({
    ownerId: login.kind === 'admin' ? login.user.id : login.member.anchorId,
    loginId: login.loginId,
    role: login.kind,
    name: body.name,
    access: body.access,
    expiresAt,
  });

  auditFireAndForget({
    actorId: login.loginId,
    actorEmail: login.email,
    action: 'key.created',
    method: 'POST',
    path: '/api/access-keys',
    ...(await requestMeta()),
    detail: {
      keyId: id,
      keyPrefix: `mtlk_${prefix}`,
      name: body.name,
      role: login.kind,
      access: body.access,
      areas: body.areas,
      riskyTools,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
  });

  return NextResponse.json(
    {
      id,
      prefix: `mtlk_${prefix}`,
      secret: key,
      expiresAt: expiresAt?.toISOString() ?? null,
    } satisfies AccessKeyCreated,
    { status: 201, headers: NO_STORE },
  );
}

export const GET = ruleInQuery(handleGET);
export const POST = ruleInQuery(handlePOST);
