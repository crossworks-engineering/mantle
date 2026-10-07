/**
 * Inbound API keys (plan page 1e62e204). Every login, any role, signed in
 * with a session or a device token; a key itself can never reach this
 * route (keys work on /api/v1 and /api/mcp only).
 *
 * A key acts as the login that MADE it, and nothing else (Jason,
 * 2026-10-07, audit item 8): nobody can make a key that acts as another
 * login. An admin's key acts as that admin, a member's as that member, a
 * client's as that client.
 *
 * GET  /api/access-keys : the keys the caller may see (never the secret or
 *      its hash), the areas, the default expiry, and the caller's role. A
 *      member or client sees their own keys. An admin sees EVERY key, with
 *      its last-use address (audit item 4, decided): every admin already
 *      reads the audit log, addresses included, and must be able to find
 *      and revoke any key.
 * POST /api/access-keys { name, access, areas, expiresInDays?,
 *      riskyTools? } : make a key for the caller's own login. The secret is
 *      in this answer ONCE. `areas` null = every area; `expiresInDays`
 *      omitted = the default, null = never. `riskyTools` only for an admin.
 *      At most MAX_LIVE_KEYS_PER_LOGIN live keys per login.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getLoginOr401 } from '@/lib/auth';
import {
  ACCESS_KEY_ACCESS,
  ACCESS_KEY_AREAS,
  DEFAULT_ACCESS_KEY_EXPIRY_DAYS,
  MAX_ACCESS_KEY_EXPIRY_DAYS,
  MAX_LIVE_KEYS_PER_LOGIN,
  expiryFromDays,
  mintAccessKey,
} from '@/lib/access-keys';
import { countLiveAccessKeys, listAccessKeys } from '@/lib/access-keys-admin';
import { auditFireAndForget, requestMeta } from '@/lib/audit';
import { firstIssue } from '@/lib/zod-issue';
import type { AccessKeyCreated, AccessKeyList } from '@mantle/client-types';

const NO_STORE = { 'Cache-Control': 'no-store' };

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
  })
  // A key is always the caller's own: a body that names a login is refused
  // rather than quietly ignored.
  .strict();

export async function GET() {
  const login = await getLoginOr401();
  if (login instanceof Response) return login;
  const keys = await listAccessKeys(login.kind === 'admin' ? null : login.loginId);
  return NextResponse.json(
    {
      keys,
      role: login.kind,
      areas: [...ACCESS_KEY_AREAS],
      defaultExpiryDays: DEFAULT_ACCESS_KEY_EXPIRY_DAYS,
    } satisfies AccessKeyList,
    { headers: NO_STORE },
  );
}

export async function POST(req: Request) {
  const login = await getLoginOr401();
  if (login instanceof Response) return login;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const body = parsed.data;
  const riskyTools = body.riskyTools ?? [];
  if (riskyTools.length > 0 && login.kind !== 'admin') {
    return NextResponse.json({ error: 'Risky tools are for an admin key.' }, { status: 400 });
  }
  if ((await countLiveAccessKeys(login.loginId)) >= MAX_LIVE_KEYS_PER_LOGIN) {
    return NextResponse.json(
      {
        error: `You have ${MAX_LIVE_KEYS_PER_LOGIN} keys. Revoke one you no longer use, then make a new one.`,
      },
      { status: 409 },
    );
  }

  const expiresAt = expiryFromDays(body.expiresInDays);
  const { id, prefix, key } = await mintAccessKey({
    name: body.name,
    loginId: login.loginId,
    loginRole: login.kind,
    access: body.access,
    areas: body.areas,
    riskyTools,
    expiresAt,
    createdBy: login.loginId,
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
