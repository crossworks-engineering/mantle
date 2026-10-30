import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  db,
  getDefaultWorker,
  onFullSystemRoute,
  systemDb,
  apiKeys,
  type AiWorker,
  type AiWorkerKind,
  type ApiKey,
  type VaultKind,
} from '@mantle/db';
import { open, seal } from '@mantle/crypto';
import { InputError } from '@mantle/std';
import { type ProviderCredential } from '@mantle/voice-client';
import { checkedWorkspaceId, maskPlaintext } from './shape';

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
  /** What agents say: the service, or service/label (0346). */
  name: string;
  /** token, password, ssh_key or login (0346). */
  kind: VaultKind;
  service: string;
  label: string;
  /** First-4 + last-4 of a long token, e.g. `sk-1…abcd`; dots for anything
   *  else. Never the full key. */
  masked: string;
  /** Where it may be used: hosts or web origins; empty = a provider key. */
  target: string[];
  tags: string[];
  needsApproval: boolean;
  viaTailnet: boolean;
  /** Anthropic only: the workspace id the key names on every call, or null.
   *  Not secret (an id, never the key). */
  anthropicWorkspaceId: string | null;
  lastUsed: Date | null;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export { maskPlaintext } from './shape';

/** List rows for a user. Reads the precomputed `masked` column instead
 *  of decrypting every row — keeps every plaintext out of process
 *  memory for an operation that doesn't actually need it, and saves a
 *  chunk of AES work on every settings/keys page load. */
export async function listApiKeys(userId: string): Promise<ApiKeySummary[]> {
  const rows = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      kind: apiKeys.kind,
      service: apiKeys.service,
      label: apiKeys.label,
      masked: apiKeys.masked,
      target: apiKeys.target,
      tags: apiKeys.tags,
      needsApproval: apiKeys.needsApproval,
      viaTailnet: apiKeys.viaTailnet,
      anthropicWorkspaceId: apiKeys.anthropicWorkspaceId,
      lastUsed: apiKeys.lastUsed,
      useCount: apiKeys.useCount,
      createdAt: apiKeys.createdAt,
      updatedAt: apiKeys.updatedAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.updatedAt));
  return rows.map((r) => ({
    ...r,
    name: r.name ?? (r.label === 'default' ? r.service : `${r.service}/${r.label}`),
  }));
}

/**
 * The rows a read path may open: tokens only (0346). A password, an SSH key
 * or a login is never handed to a provider adapter, an HTTP template or a
 * connector by these reads; only the use gateway (vault part 2) will open
 * one, for its own target.
 */
const OPENABLE = eq(apiKeys.kind, 'token');

/**
 * Open a key row into its credential: the plaintext, plus what the row
 * carries besides (an Anthropic key's workspace id). THE one place a key row
 * is opened, so every lookup below returns the same handle and the adapter
 * sends exactly this row's fields (anthropicHeaders reads the credential it
 * is given; nothing is looked up by the key value). A field a provider needs
 * later (an OpenAI organization or project) is filled here the same way.
 * Tokens only: every lookup below filters by OPENABLE, and this refuses
 * another kind whatever reached it.
 */
function openKeyRow(row: ApiKey): ProviderCredential {
  if (row.kind !== 'token') throw new Error('openKeyRow: only a token is opened here');
  const apiKey = open(row.keyEnc, row.id);
  return row.service === 'anthropic' && row.anthropicWorkspaceId
    ? { apiKey, anthropicWorkspaceId: row.anthropicWorkspaceId }
    : { apiKey };
}

// Key READS use systemDb: the process needs a model's credentials whatever the
// viewer (a team turn runs on a limited role, member logins Phase 0b), and a
// key never reaches the model. Key management stays on `db` (owner paths).

/** Open one key by its row id into its credential (openKeyRow). Used by
 * agents that reference a specific vault entry via `api_key_id`. No owner
 * check here: callers that hold a referenced id have already passed the
 * owner gate. */
export async function getApiKeyById(id: string): Promise<ProviderCredential | null> {
  const [row] = await systemDb
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), OPENABLE))
    .limit(1);
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
    .where(
      and(
        eq(apiKeys.userId, userId),
        eq(apiKeys.service, service),
        eq(apiKeys.label, label),
        OPENABLE,
      ),
    )
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
 * 'default' alone would find nothing for it. Null: no key of that service on
 * file.
 */
export async function findProviderKeyId(userId: string, service: string): Promise<string | null> {
  const [row] = await systemDb
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.service, service), OPENABLE))
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
    .where(and(eq(apiKeys.userId, userId), OPENABLE))
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
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId), OPENABLE))
    .limit(1);
  return row?.service ?? null;
}

/** Set (UPSERT) the key for (user, service, label). "Set" must be idempotent —
 *  re-saving during onboarding/settings used to 23505 on the unique constraint
 *  and surface as a silent 500. NOTE the ciphertext is sealed with the row id
 *  as AAD, so a SQL ON CONFLICT UPDATE would poison the surviving row with a
 *  ciphertext sealed against a different id — when a row exists we RESEAL
 *  against its id instead. Insert allocates the id up-front so AAD is known
 *  before seal(). For the internal writers (a connector's OAuth state, the
 *  sandbox proxy token, onboarding): an owner's client sets a key through
 *  the vault gateway (vault.ts setVaultKey: its gate and its audit row). */
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
    .select({ id: apiKeys.id, kind: apiKeys.kind })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, userId), eq(apiKeys.service, service), eq(apiKeys.label, label)))
    .limit(1);
  // A token write never lands on a password, an SSH key or a login: it
  // would keep that kind with a token's value.
  if (existing && existing.kind !== 'token') {
    throw new InputError(`${service}/${label} holds a ${existing.kind}, not a token.`);
  }
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
  // A key made is not the narrow login's (access-matrix.ts
  // NARROW_NEVER_INSERT): its seal binds its id only, so with INSERT and
  // DELETE a narrow session could put a key back under another service.
  // The full-route spot model-route (where a vault key goes).
  const [inserted] = await onFullSystemRoute('model-route', () =>
    db
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
      .returning(),
  );
  if (!inserted) throw new Error('failed to insert api_key');
  return inserted;
}

/** Delete a key by id, for the internal writers (a connector's sealed
 *  OAuth state). An owner's client deletes through the vault gateway
 *  (vault.ts deleteVaultKey: its gate and its audit row). */
export async function deleteApiKey(userId: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, userId)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}
/** The owner's default worker of a kind with its key opened, or why not:
 *  `none` (no worker of the kind), `no_key` (it names no key),
 *  `unusable` (the caller's `usable` check refused it, asked before the key
 *  is opened, so a worker the caller cannot run never touches its key),
 *  `unreadable_key` (the key could not be opened). */
export type WorkerRoute =
  | { ok: true; worker: AiWorker; credential: ProviderCredential }
  | { ok: false; why: 'none'; worker: null }
  | { ok: false; why: 'no_key' | 'unusable' | 'unreadable_key'; worker: AiWorker };

/**
 * The one resolution of an owner's default worker and its key, shared by
 * every caller that runs the worker itself (runtime's runVisionWorker, the
 * image check in @mantle/tools, the worker tools through their wording
 * defaultWorkerOrError), so each refuses the same cases in the same order:
 * the worker, its key reference, the caller's check, the key.
 */
export async function resolveDefaultWorker(
  ownerId: string,
  kind: AiWorkerKind,
  usable?: (worker: AiWorker) => boolean,
): Promise<WorkerRoute> {
  return workerRoute(await getDefaultWorker(ownerId, kind), usable, getApiKeyById);
}

/** resolveDefaultWorker's order over a worker already read, with the key
 *  opener passed in: the same refusals for a test that stubs the key read
 *  (a module mock cannot reach this module's own call). */
export async function workerRoute(
  worker: AiWorker | null,
  usable: ((worker: AiWorker) => boolean) | undefined,
  openKey: (id: string) => Promise<ProviderCredential | null>,
): Promise<WorkerRoute> {
  if (!worker) return { ok: false, why: 'none', worker: null };
  if (!worker.apiKeyId) return { ok: false, why: 'no_key', worker };
  if (usable && !usable(worker)) return { ok: false, why: 'unusable', worker };
  const credential = await openKey(worker.apiKeyId);
  if (!credential) return { ok: false, why: 'unreadable_key', worker };
  return { ok: true, worker, credential };
}

export * from './services';
export * from './vault';
export { probeApiKey, type TestApiKeyResult } from './probe';
export { scrubSecrets } from './scrub';
