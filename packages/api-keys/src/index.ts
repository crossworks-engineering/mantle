import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db, apiKeys, type ApiKey } from '@mantle/db';
import { open, seal } from '@mantle/crypto';

/**
 * Encrypted-at-rest API key storage. Every call is owner-scoped — pass the
 * user's id explicitly; never trust client-supplied user ids.
 *
 * Used by:
 *   - apps/web (`/settings/keys` UI, /api/keys routes)
 *   - apps/agent (reads `openrouter` key at startup)
 *   - future MCP tools that need to call external LLMs
 */

export type ApiKeySummary = {
  id: string;
  service: string;
  label: string;
  /** First-4 + last-4 of the plaintext, e.g. `sk-1…abcd`. Never the full key. */
  masked: string;
  lastUsed: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Compute the display mask. Exported so create/rotate can stash it
 *  alongside the ciphertext at write time. */
export function maskPlaintext(plaintext: string): string {
  if (plaintext.length < 8) return '••••';
  return `${plaintext.slice(0, 4)}…${plaintext.slice(-4)}`;
}

/** List rows for a user. Reads the precomputed `masked` column instead
 *  of decrypting every row — keeps every plaintext out of process
 *  memory for an operation that doesn't actually need it, and saves a
 *  chunk of AES work on every settings/keys page load. */
export async function listApiKeys(userId: string): Promise<ApiKeySummary[]> {
  const rows = await db
    .select({
      id: apiKeys.id,
      service: apiKeys.service,
      label: apiKeys.label,
      masked: apiKeys.masked,
      lastUsed: apiKeys.lastUsed,
      createdAt: apiKeys.createdAt,
      updatedAt: apiKeys.updatedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.updatedAt));
  return rows;
}

/** Read the plaintext for one key by its row id. Used by agents that reference
 * a specific vault entry via `api_key_id`. No owner check here — callers
 * that hold a referenced id have already passed the owner gate. */
export async function getApiKeyById(id: string): Promise<string | null> {
  const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  if (!row) return null;
  const plaintext = open(row.keyEnc, row.id);
  void db
    .update(apiKeys)
    .set({ lastUsed: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch(() => {});
  return plaintext;
}

/** Read the plaintext for one key. Bumps `last_used` opportunistically. */
export async function getApiKey(
  userId: string,
  service: string,
  label = 'default',
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.service, service),
        eq(apiKeys.label, label),
      ),
    )
    .limit(1);
  if (!row) return null;
  const plaintext = open(row.keyEnc, row.id);
  // Best-effort last_used bump.
  void db
    .update(apiKeys)
    .set({ lastUsed: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch(() => {});
  return plaintext;
}

/** Set (UPSERT) the key for (user, service, label). "Set" must be idempotent —
 *  re-saving during onboarding/settings used to 23505 on the unique constraint
 *  and surface as a silent 500. NOTE the ciphertext is sealed with the row id
 *  as AAD, so a SQL ON CONFLICT UPDATE would poison the surviving row with a
 *  ciphertext sealed against a different id — when a row exists we RESEAL
 *  against its id instead (same as rotateApiKey). Insert allocates the id
 *  up-front so AAD is known before seal(). */
export async function setApiKey(
  userId: string,
  service: string,
  label: string,
  plaintext: string,
): Promise<ApiKey> {
  const [existing] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(eq(apiKeys.userId, userId), eq(apiKeys.service, service), eq(apiKeys.label, label)),
    )
    .limit(1);
  if (existing) {
    const { ciphertext, keyVersion } = seal(plaintext, existing.id);
    const [updated] = await db
      .update(apiKeys)
      .set({
        keyEnc: ciphertext,
        keyVersion,
        masked: maskPlaintext(plaintext),
        updatedAt: new Date(),
      })
      .where(eq(apiKeys.id, existing.id))
      .returning();
    if (!updated) throw new Error('failed to update api_key');
    return updated;
  }
  const id = randomUUID();
  const { ciphertext, keyVersion } = seal(plaintext, id);
  const masked = maskPlaintext(plaintext);
  const [inserted] = await db
    .insert(apiKeys)
    .values({ id, userId, service, label, keyEnc: ciphertext, keyVersion, masked })
    .returning();
  if (!inserted) throw new Error('failed to insert api_key');
  return inserted;
}

/** Replace the ciphertext on an existing key. Verifies ownership first. */
export async function rotateApiKey(
  userId: string,
  id: string,
  plaintext: string,
): Promise<ApiKey | null> {
  const [row] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
    .limit(1);
  if (!row) return null;
  const { ciphertext, keyVersion } = seal(plaintext, row.id);
  const masked = maskPlaintext(plaintext);
  const [updated] = await db
    .update(apiKeys)
    .set({ keyEnc: ciphertext, keyVersion, masked, updatedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .returning();
  return updated ?? null;
}

export async function deleteApiKey(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}
