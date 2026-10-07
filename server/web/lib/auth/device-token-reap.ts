/**
 * The reaper for dead device tokens (maintenance sweep `device-tokens-reap`,
 * plain SQL, no model). A `mobile_tokens` row stays after its token is
 * revoked (a sign-out, a rotation, End sessions) or expired: the row is what
 * says "revoked", and a rotated row is what detects a copy of an old token
 * presented again (POST /api/auth/token/refresh). Neither needs it for ever.
 *
 * A row is deleted {@link DEVICE_TOKEN_RETENTION_DAYS} days after it was
 * revoked or expired: by then a token of any lifetime the brain mints for a
 * rotating client (30 days) is long past use, and a signed token whose row
 * is gone is refused like any unknown token. The push devices a deleted row
 * enrolled go with it (FK cascade); they were already unreachable.
 */
import { and, isNotNull, lt, or } from 'drizzle-orm';
import { db, mobileTokens } from '@mantle/db';

export const DEVICE_TOKEN_RETENTION_DAYS = 30;

export async function reapDeviceTokens(
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<{ deleted: number }> {
  const now = opts.now ?? new Date();
  const before = new Date(now.getTime() - DEVICE_TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const dead = or(
    and(isNotNull(mobileTokens.revokedAt), lt(mobileTokens.revokedAt, before)),
    lt(mobileTokens.expiresAt, before),
  );
  if (opts.dryRun) {
    const rows = await db.select({ id: mobileTokens.id }).from(mobileTokens).where(dead);
    return { deleted: rows.length };
  }
  const rows = await db.delete(mobileTokens).where(dead).returning({ id: mobileTokens.id });
  return { deleted: rows.length };
}
