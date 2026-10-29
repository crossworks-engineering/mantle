/**
 * Inbound API keys (docs/workspaces.md). Every login, signed in with a
 * session or a device token; a key itself can never reach this route (keys
 * work on /api/v1 and /api/mcp only).
 *
 * A key acts as the login that MADE it, and nothing else: nobody can make a
 * key that acts as another login. It keeps no role of its own: it reads
 * what its login's workspaces read now.
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
 *      What a login may make is decided by its workspaces, never its role:
 *      "never", or more than 90 days (up to 3650), and risky tools,
 *      only for a login that holds the Admin workspace with its keys area;
 *      everyone else's key ends within 90 days and names no risky tool (the
 *      admin gate still decides each risky call). A stolen session must not
 *      be able to mint a key unseen: every login re-types its
 *      password (10 wrong tries a minute per login), and is told a key was
 *      made. A password change, "sign out everywhere" and an admin's End
 *      sessions revoke every key the login holds (endLoginSessions
 *      `endKeys`).
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { anyLoginCaller, sessionRole, verifyPassword } from '@/lib/auth';
import { adminFacts, type Login } from '@/lib/auth/login';
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
import { listAccessKeys } from '@/lib/access-keys-admin';
import { notifyKeyMade } from '@/lib/access-keys-notify';
import { rateLimitLogin, rateLimitLoginRefund } from '@/lib/rate-limit';
import { rateLimitedResponse } from '@/lib/route-limits';
import { auditFireAndForget, requestMeta } from '@/lib/audit';
import type { AccessKeyCreated, AccessKeyList } from '@mantle/client-types';
import { inRuleInQuery } from '@/lib/auth/rule-in-query';
import { readBody } from '@/lib/read-body';
import { CACHE_CONTROL } from '@/lib/cache-control';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any' },
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: "the login's own things, not an item" },
    audit: 'own',
  },
});

const NO_STORE = { 'Cache-Control': CACHE_CONTROL.none };
/** Keys a login may make an hour: a make-and-revoke loop
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

async function handleGET(login: Login) {
  // An Admin user sees every key; any other login its own (adminFacts: the
  // scope's answer). What a key may be decides on the keys area, never on
  // the role.
  const facts = await adminFacts(login);
  const keys = await listAccessKeys(facts.admin ? null : login.loginId);
  const maxDays = maxKeyDays(facts.areas.has('keys'));
  return NextResponse.json(
    {
      keys,
      // The display role (sessionRole: from Admin membership).
      role: sessionRole(login),
      areas: [...ACCESS_KEY_AREAS],
      defaultExpiryDays: Math.min(DEFAULT_ACCESS_KEY_EXPIRY_DAYS, maxDays ?? Infinity),
      maxExpiryDays: maxDays,
      // Every login re-types its password (kept on the wire for older apps).
      needsPassword: true,
    } satisfies AccessKeyList,
    { headers: NO_STORE },
  );
}

async function handlePOST(login: Login, req: Request) {
  const input = await readBody(req, Body, { empty: null });
  const body = input;
  const riskyTools = body.riskyTools ?? [];
  // The login holds the Admin workspace with its keys area now (adminFacts,
  // asked unscoped here: the area rule about the login, with its Admin pair).
  const keysArea = (await adminFacts(login)).areas.has('keys');
  const role = sessionRole(login);
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
  // guesses cannot all pass a peek; a right password gives
  // its token back, so making several keys is not guessing. A failure
  // budget taken around the password check, not a route gate: named in
  // eslint-rules/route-plumbing.mjs RATE_LIMIT_ALLOW, answered with the one
  // 429.
  const bucket = `akey-pw:${login.loginId}`;
  const tries = rateLimitLogin(bucket, PASSWORD_RATE);
  if (!tries.ok) return rateLimitedResponse(tries.retryAfterSec);
  if (!body.password || !(await verifyPassword(login.loginId, body.password))) {
    return NextResponse.json(
      { error: 'Type your password to make a key.', reason: 'password' },
      { status: 403 },
    );
  }
  rateLimitLoginRefund(bucket);

  // Counted only once the password passed: the keys made, not the tries.
  const made = rateLimitLogin(`akey-create:${login.loginId}`, CREATE_RATE);
  if (!made.ok) return rateLimitedResponse(made.retryAfterSec);

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
    ownerId: login.brainId,
    loginId: login.loginId,
    role,
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
      role,
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

// The login the pipeline answered (any login). The list
// runs where the request runs, by its definer (listAccessKeys). Making a key
// still leaves the scope by name: its password check reads the login's hash
// and the new key's row is written on the system pool.
export async function GET() {
  const login = anyLoginCaller();
  return handleGET(login);
}

export async function POST(req: Request) {
  const login = anyLoginCaller();
  return inRuleInQuery(() => handlePOST(login, req));
}
