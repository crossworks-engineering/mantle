/**
 * Inbound API keys (plan page 1e62e204). Owner or admin only; a key itself
 * can never reach this route (keys work on /api/v1 and /api/mcp only).
 *
 * GET  /api/access-keys : every key (never the secret or its hash), the
 *      logins the caller may make a key for, the areas, the default expiry.
 * POST /api/access-keys { name, loginId, access, areas, expiresInDays?,
 *      riskyTools? } : make a key. The secret is in this answer ONCE.
 *      `areas` null = every area; `expiresInDays` omitted = the default,
 *      null = never. A key acts as the caller's own login, or as a member
 *      or client login; never as another admin. `riskyTools` only for a key
 *      that acts as an admin.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { loadLoginRow } from '@/lib/auth/login-row';
import {
  ACCESS_KEY_ACCESS,
  ACCESS_KEY_AREAS,
  DEFAULT_ACCESS_KEY_EXPIRY_DAYS,
  MAX_ACCESS_KEY_EXPIRY_DAYS,
  expiryFromDays,
  mintAccessKey,
} from '@/lib/access-keys';
import { accessKeyLoginOptions, listAccessKeys } from '@/lib/access-keys-admin';
import { auditFireAndForget, requestMeta } from '@/lib/audit';
import { firstIssue } from '@/lib/zod-issue';

const NO_STORE = { 'Cache-Control': 'no-store' };

const Body = z.object({
  name: z.string().trim().min(1, 'Name the key.').max(100),
  loginId: z.string().uuid(),
  access: z.enum(ACCESS_KEY_ACCESS),
  areas: z.array(z.enum(ACCESS_KEY_AREAS)).min(1).max(ACCESS_KEY_AREAS.length).nullable(),
  expiresInDays: z.number().int().min(1).max(MAX_ACCESS_KEY_EXPIRY_DAYS).nullable().optional(),
  riskyTools: z
    .array(z.string().regex(/^[a-z0-9_]{1,64}$/, 'A tool slug.'))
    .max(50)
    .optional(),
});

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const [keys, logins] = await Promise.all([
    listAccessKeys(),
    accessKeyLoginOptions(user.actor.id),
  ]);
  return NextResponse.json(
    {
      keys,
      logins,
      areas: ACCESS_KEY_AREAS,
      defaultExpiryDays: DEFAULT_ACCESS_KEY_EXPIRY_DAYS,
    },
    { headers: NO_STORE },
  );
}

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const body = parsed.data;

  const login = await loadLoginRow(body.loginId);
  if (!login || !login.email || login.disabledAt) {
    return NextResponse.json({ error: 'No such login.' }, { status: 404 });
  }
  if (login.role === 'admin' && login.id !== user.actor.id) {
    return NextResponse.json(
      { error: 'A key that acts as an admin is made by that admin.' },
      { status: 403 },
    );
  }
  const riskyTools = body.riskyTools ?? [];
  if (riskyTools.length > 0 && login.role !== 'admin') {
    return NextResponse.json(
      { error: 'Risky tools are for a key that acts as an admin.' },
      { status: 400 },
    );
  }

  const expiresAt = expiryFromDays(body.expiresInDays);
  const { id, prefix, key } = await mintAccessKey({
    name: body.name,
    loginId: login.id,
    loginRole: login.role,
    sessionEpoch: login.sessionEpoch,
    access: body.access,
    areas: body.areas,
    riskyTools,
    expiresAt,
    createdBy: user.actor.id,
  });

  auditFireAndForget({
    actorId: user.actor.id,
    actorEmail: user.actor.email,
    action: 'key.created',
    method: 'POST',
    path: '/api/access-keys',
    ...(await requestMeta()),
    detail: {
      keyId: id,
      keyPrefix: `mtlk_${prefix}`,
      name: body.name,
      loginId: login.id,
      role: login.role,
      access: body.access,
      areas: body.areas,
      riskyTools,
      expiresAt: expiresAt?.toISOString() ?? null,
    },
  });

  return NextResponse.json(
    { id, prefix: `mtlk_${prefix}`, secret: key, expiresAt: expiresAt?.toISOString() ?? null },
    { status: 201, headers: NO_STORE },
  );
}
