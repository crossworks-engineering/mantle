import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, systemDb, apiKeys, type ApiKey } from '@mantle/db';
import { open, seal } from '@mantle/crypto';
import { InputError } from '@mantle/std';
import { normalizeAnthropicWorkspaceId, type ProviderCredential } from '@mantle/voice-client';

export type { ProviderCredential };

/**
 * Encrypted-at-rest API key storage. Every call is owner-scoped — pass the
 * user's id explicitly; never trust client-supplied user ids.
 *
 * Used by:
 *   - server/web (`/settings/keys` UI, /api/keys routes)
 *   - server/api (reads `openrouter` key at startup)
 *   - future MCP tools that need to call external LLMs
 */

export type ApiKeySummary = {
  id: string;
  service: string;
  label: string;
  /** First-4 + last-4 of the plaintext, e.g. `sk-1…abcd`. Never the full key. */
  masked: string;
  /** Anthropic only: the workspace id the key names on every call, or null.
   *  Not secret (an id, never the key). */
  anthropicWorkspaceId: string | null;
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
      anthropicWorkspaceId: apiKeys.anthropicWorkspaceId,
      lastUsed: apiKeys.lastUsed,
      createdAt: apiKeys.createdAt,
      updatedAt: apiKeys.updatedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.updatedAt));
  return rows;
}

/**
 * Open a key row into its credential: the plaintext, plus what the row
 * carries besides (an Anthropic key's workspace id). THE one place a key row
 * is opened, so every lookup below returns the same handle and the adapter
 * sends exactly this row's fields (anthropicHeaders reads the credential it
 * is given; nothing is looked up by the key value). A field a provider needs
 * later (an OpenAI organization or project) is filled here the same way.
 */
function openKeyRow(row: ApiKey): ProviderCredential {
  const apiKey = open(row.keyEnc, row.id);
  return row.service === 'anthropic' && row.anthropicWorkspaceId
    ? { apiKey, anthropicWorkspaceId: row.anthropicWorkspaceId }
    : { apiKey };
}

/** The workspace id as stored: trimmed, null for none. Throws InputError
 *  (a 400 with this text) for one that could never be a header value. */
function checkedWorkspaceId(raw: string | null | undefined): string | null {
  const checked = normalizeAnthropicWorkspaceId(raw);
  if (!checked.ok) throw new InputError(checked.error);
  return checked.value;
}

// Key READS use systemDb: the process needs a model's credentials whatever the
// viewer (a team turn runs on a limited role, member logins Phase 0b), and a
// key never reaches the model. Key management stays on `db` (owner paths).

/** Open one key by its row id into its credential (openKeyRow). Used by
 * agents that reference a specific vault entry via `api_key_id`. No owner
 * check here: callers that hold a referenced id have already passed the
 * owner gate. */
export async function getApiKeyById(id: string): Promise<ProviderCredential | null> {
  const [row] = await systemDb.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  if (!row) return null;
  const credential = openKeyRow(row);
  void systemDb
    .update(apiKeys)
    .set({ lastUsed: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch(() => {});
  return credential;
}

/** Open one key by owner, service and label into its credential
 *  (openKeyRow). Bumps `last_used` opportunistically. */
export async function getApiKey(
  userId: string,
  service: string,
  label = 'default',
): Promise<ProviderCredential | null> {
  const [row] = await systemDb
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.service, service), eq(apiKeys.label, label)))
    .limit(1);
  if (!row) return null;
  const credential = openKeyRow(row);
  // Best-effort last_used bump.
  void systemDb
    .update(apiKeys)
    .set({ lastUsed: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch(() => {});
  return credential;
}

/**
 * The order a service's keys are picked in when nothing pins one: the key
 * labelled 'default', else the oldest, ties broken by id. Stable on purpose:
 * it reads nothing a read changes (getApiKeyById bumps `last_used`), so a
 * pinned run, or merely opening the picker on another key, never moves which
 * key every unpinned lookup uses.
 */
const PICK_ORDER = () => [
  sql`(${apiKeys.label} = 'default') desc`,
  asc(apiKeys.createdAt),
  asc(apiKeys.id),
];

/**
 * The id of the key a provider call uses when nothing pins one: the key
 * labelled 'default', else the oldest key of that service (ties by id). A
 * key added on /settings/keys keeps whatever label was typed, so a lookup of
 * 'default' alone found nothing for it (task 698e6faf). Null: no key of that
 * service on file.
 */
export async function findProviderKeyId(userId: string, service: string): Promise<string | null> {
  const [row] = await systemDb
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.service, service)))
    .orderBy(...PICK_ORDER())
    .limit(1);
  return row?.id ?? null;
}

/**
 * {@link findProviderKeyId} for every service the owner holds a key of, in
 * one read: service to the id of the key an unpinned lookup would use. For
 * callers that pin a key per service at once (the manifest seeder, the model
 * combos).
 */
export async function findProviderKeyIds(userId: string): Promise<Map<string, string>> {
  const rows = await systemDb
    .select({ id: apiKeys.id, service: apiKeys.service })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(...PICK_ORDER());
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.service)) out.set(r.service, r.id);
  return out;
}

/**
 * THE lookup of a model provider's key (chat, embeddings, workers, the
 * model catalog): the pinned key when `keyId` names one that still opens,
 * else {@link findProviderKeyId}'s pick. Callers hold `keyId` from a row that
 * already passed the owner gate (an agent's, a worker's, a route's), as with
 * {@link getApiKeyById}. A hard `getApiKey(owner, provider)` read only the
 * 'default' label; that is pinned at none outside this package
 * (provider-key-lookups.test.ts).
 */
export async function resolveProviderKey(
  userId: string,
  service: string,
  keyId?: string | null,
): Promise<ProviderCredential | null> {
  if (keyId) {
    const pinned = await getApiKeyById(keyId);
    if (pinned) return pinned;
  }
  const id = await findProviderKeyId(userId, service);
  return id ? getApiKeyById(id) : null;
}

/**
 * The service of the key `id` when `userId` owns it, else null: the check a
 * caller-supplied key id passes before use (/api/models?keyId=). Another
 * owner's key and a missing one answer the same null.
 */
export async function ownedKeyService(userId: string, id: string): Promise<string | null> {
  const [row] = await systemDb
    .select({ service: apiKeys.service })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
    .limit(1);
  return row?.service ?? null;
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
  opts: {
    /** Anthropic keys only. Undefined keeps what an existing row has; null
     *  or blank clears it. */
    anthropicWorkspaceId?: string | null;
  } = {},
): Promise<ApiKey> {
  const workspace =
    opts.anthropicWorkspaceId === undefined
      ? undefined
      : checkedWorkspaceId(opts.anthropicWorkspaceId);
  if (workspace && service !== 'anthropic') {
    throw new InputError('Only an Anthropic key can carry a workspace id.');
  }
  const [existing] = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.service, service), eq(apiKeys.label, label)))
    .limit(1);
  if (existing) {
    const { ciphertext, keyVersion } = seal(plaintext, existing.id);
    const [updated] = await db
      .update(apiKeys)
      .set({
        keyEnc: ciphertext,
        keyVersion,
        masked: maskPlaintext(plaintext),
        ...(workspace !== undefined ? { anthropicWorkspaceId: workspace } : {}),
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
    .values({
      id,
      userId,
      service,
      label,
      keyEnc: ciphertext,
      keyVersion,
      masked,
      anthropicWorkspaceId: workspace ?? null,
    })
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

/**
 * Set or clear (null, blank) the Anthropic workspace id on the caller's key
 * `id`. Null: no such key of this owner. Throws InputError for a key of
 * another service, or an id that could never be a header value. The next
 * read of the key carries it (openKeyRow); the key itself is untouched.
 */
export async function setApiKeyAnthropicWorkspace(
  userId: string,
  id: string,
  workspaceId: string | null,
): Promise<{ id: string; anthropicWorkspaceId: string | null; updatedAt: Date } | null> {
  const value = checkedWorkspaceId(workspaceId);
  const [row] = await db
    .select({ id: apiKeys.id, service: apiKeys.service })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
    .limit(1);
  if (!row) return null;
  if (row.service !== 'anthropic') {
    throw new InputError('Only an Anthropic key can carry a workspace id.');
  }
  const [updated] = await db
    .update(apiKeys)
    .set({ anthropicWorkspaceId: value, updatedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .returning({
      id: apiKeys.id,
      anthropicWorkspaceId: apiKeys.anthropicWorkspaceId,
      updatedAt: apiKeys.updatedAt,
    });
  return updated ?? null;
}

export async function deleteApiKey(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}
export * from './services';
