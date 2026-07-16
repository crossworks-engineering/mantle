/**
 * Secrets surface. Two-layer design:
 *
 *   - `nodes` row (type='secret'): plaintext metadata — title, description,
 *     tags, kind — that the responder + extractor are allowed to see.
 *     This is what makes a secret findable ("my Linode root password").
 *   - `secrets` row (sealed bytea): AES-256-GCM ciphertext for the
 *     {note, fields} payload. Never touched by the extractor and never
 *     leaves the server unless `revealSecret` is called from an
 *     owner-authenticated route.
 *
 * Security invariants:
 *   - `listSecrets` / `getSecret` never return ciphertext or plaintext fields.
 *   - `revealSecret` requires an owner-scoped session and is the ONLY
 *     entry point that decrypts.
 *   - The sealed AAD is `secret:<node_id>` so a ciphertext from one row
 *     can't be replayed against another even if an attacker swaps the
 *     bytea column.
 *   - All new secret nodes land under the `secrets` ltree root, which
 *     the extractor reads as metadata-only (`apps/agent/src/extractor.ts`
 *     special-cases `type='secret'` to feed title + description + tags
 *     and nothing else to the LLM).
 */

import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm';
import { db, nodes, notifyNodeIngested, secrets, type Node } from '@mantle/db';
import { seal, open } from '@mantle/crypto';

/** ltree root label for all secrets. Mirrors the `files` root convention
 *  but is NOT host-mirrored — secrets stay in Postgres only. */
export const SECRETS_ROOT_LABEL = 'secrets';

/** Kinds are a free-form hint for the UI/filtering. They DON'T constrain
 *  the field shape — the hybrid model lets each secret carry an
 *  arbitrary set of {label, value} fields plus a free-form note. */
export const SECRET_KINDS = ['password', 'token', 'server', 'card', 'note', 'other'] as const;
export type SecretKind = (typeof SECRET_KINDS)[number];

export type SecretRow = {
  id: string;
  title: string;
  description: string;
  kind: SecretKind;
  tags: string[];
  hasNote: boolean;
  fieldCount: number;
  /** Summary written by the extractor; null until the next extractor pass. */
  summary: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SecretField = {
  label: string;
  value: string;
};

export type SecretPayload = {
  note: string;
  fields: SecretField[];
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function nodeToRow(node: Node): SecretRow {
  const data = (node.data ?? {}) as Record<string, unknown>;
  return {
    id: node.id,
    title: node.title,
    description: typeof data.description === 'string' ? data.description : '',
    kind:
      typeof data.kind === 'string' && (SECRET_KINDS as readonly string[]).includes(data.kind)
        ? (data.kind as SecretKind)
        : 'other',
    tags: node.tags ?? [],
    hasNote: Boolean(data.has_note),
    fieldCount: typeof data.field_count === 'number' ? data.field_count : 0,
    summary: typeof data.summary === 'string' ? data.summary : null,
    createdAt: node.createdAt.toISOString(),
    updatedAt: node.updatedAt.toISOString(),
  };
}

/** Lazy-create the `secrets` root branch the first time a secret is
 *  added. Same pattern as `ensureFilesRootBranch` over in @mantle/files
 *  but without the disk side. */
async function ensureSecretsRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Secrets',
      slug: SECRETS_ROOT_LABEL,
      path: SECRETS_ROOT_LABEL,
      data: {
        description:
          'Encrypted credentials, tokens, and other sensitive notes. Metadata is searchable; values stay sealed until you click reveal.',
      },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

// ─── Public API ────────────────────────────────────────────────────────────

export type ListFilters = {
  query?: string;
  kind?: SecretKind | 'all';
  tag?: string;
};

/** Shared WHERE conditions for secret list/count queries. */
function secretConds(ownerId: string, filters: ListFilters) {
  const conditions = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'secret')];
  if (filters.query && filters.query.trim().length > 0) {
    const q = `%${filters.query.trim()}%`;
    const queryCond = or(
      ilike(nodes.title, q),
      sql`${nodes.data}->>'description' ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (queryCond) conditions.push(queryCond);
  }
  if (filters.kind && filters.kind !== 'all') {
    conditions.push(sql`${nodes.data}->>'kind' = ${filters.kind}`);
  }
  if (filters.tag) {
    conditions.push(sql`${filters.tag} = ANY(${nodes.tags})`);
  }
  return conditions;
}

export async function listSecrets(
  ownerId: string,
  filters: ListFilters & { limit?: number; offset?: number } = {},
): Promise<SecretRow[]> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(...secretConds(ownerId, filters)))
    .orderBy(desc(nodes.updatedAt))
    .limit(filters.limit ?? 500)
    .offset(filters.offset ?? 0);
  return rows.map(nodeToRow);
}

/** Total secrets matching the same filters as `listSecrets` (drives pagination). */
export async function countSecrets(ownerId: string, filters: ListFilters = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .where(and(...secretConds(ownerId, filters)));
  return row?.n ?? 0;
}

export async function getSecretMetadata(ownerId: string, id: string): Promise<SecretRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'secret')))
    .limit(1);
  return row ? nodeToRow(row) : null;
}

/** All tags currently in use, sorted by frequency. Cheap query for the
 *  filter chip strip on /secrets. */
export async function listSecretTags(ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ tag: sql<string>`unnest(${nodes.tags})` })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'secret')));
  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.tag, (seen.get(r.tag) ?? 0) + 1);
  return Array.from(seen.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
}

export type CreateSecretInput = {
  title: string;
  description: string;
  kind: SecretKind;
  tags: string[];
  note: string;
  fields: SecretField[];
};

export async function createSecret(ownerId: string, input: CreateSecretInput): Promise<SecretRow> {
  await ensureSecretsRoot(ownerId);
  const sanitisedFields = sanitiseFields(input.fields);
  const payload: SecretPayload = {
    note: input.note ?? '',
    fields: sanitisedFields,
  };

  const data = {
    description: (input.description ?? '').slice(0, 4000),
    kind: input.kind,
    has_note: payload.note.trim().length > 0,
    field_count: payload.fields.length,
  };

  const [inserted] = await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'secret',
      title: input.title.trim().slice(0, 200) || 'Untitled secret',
      slug: null,
      path: SECRETS_ROOT_LABEL,
      data,
      tags: dedupeTags(input.tags),
    })
    .returning();
  if (!inserted) throw new Error('createSecret: insert returned no row');

  const sealed = seal(JSON.stringify(payload), aadFor(inserted.id));
  await db.insert(secrets).values({
    nodeId: inserted.id,
    ciphertext: sealed.ciphertext,
    keyVersion: sealed.keyVersion,
  });

  return nodeToRow(inserted);
}

export type UpdateSecretInput = Partial<CreateSecretInput>;

export async function updateSecret(
  ownerId: string,
  id: string,
  input: UpdateSecretInput,
): Promise<SecretRow | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'secret')))
    .limit(1);
  if (!node) return null;

  // Decide if the encrypted blob needs rewriting. We rewrite only when
  // note or fields changed — metadata-only edits leave the blob alone
  // so we don't churn the AAD/ciphertext for a title rename.
  const wantsBlobRewrite = input.note !== undefined || input.fields !== undefined;
  let nextPayload: SecretPayload | null = null;
  if (wantsBlobRewrite) {
    const existing = await readSealedPayload(id);
    nextPayload = {
      note: input.note !== undefined ? input.note : existing.note,
      fields: input.fields !== undefined ? sanitiseFields(input.fields) : existing.fields,
    };
  }

  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const newData: Record<string, unknown> = {
    ...oldData,
    ...(input.description !== undefined ? { description: input.description.slice(0, 4000) } : {}),
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    ...(nextPayload
      ? {
          has_note: nextPayload.note.trim().length > 0,
          field_count: nextPayload.fields.length,
        }
      : {}),
  };
  // Editing metadata clears the stale summary/embedding so the next
  // extractor pass produces a fresh one against the new description.
  const metadataChanged =
    input.title !== undefined ||
    input.description !== undefined ||
    input.kind !== undefined ||
    input.tags !== undefined;
  if (metadataChanged) {
    delete newData.summary;
    delete newData.summary_model;
    delete newData.summary_at;
    delete newData.entities;
  }

  const [updated] = await db
    .update(nodes)
    .set({
      ...(input.title !== undefined
        ? { title: input.title.trim().slice(0, 200) || 'Untitled secret' }
        : {}),
      ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
      data: newData,
      ...(metadataChanged ? { embedding: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();
  if (!updated) throw new Error('updateSecret: update returned no row');

  if (nextPayload) {
    const sealed = seal(JSON.stringify(nextPayload), aadFor(id));
    await db
      .update(secrets)
      .set({
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        updatedAt: new Date(),
      })
      .where(eq(secrets.nodeId, id));
  }

  if (metadataChanged) {
    await notifyNodeIngested(id);
  }

  return nodeToRow(updated);
}

export async function deleteSecret(ownerId: string, id: string): Promise<boolean> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'secret')))
    .limit(1);
  if (!node) return false;
  // Cascade drops the `secrets` row too.
  await db.delete(nodes).where(eq(nodes.id, id));
  return true;
}

/**
 * Decrypt and return the {note, fields} payload. Owner-scoped check
 * happens at the route layer; this function trusts its caller to have
 * verified ownership.
 *
 * This is the ONLY function in this file that returns plaintext fields.
 * Keep it that way — auditing where the data goes is much easier when
 * the surface is a single name.
 */
export async function revealSecret(
  ownerId: string,
  id: string,
): Promise<{ metadata: SecretRow; payload: SecretPayload } | null> {
  const metadata = await getSecretMetadata(ownerId, id);
  if (!metadata) return null;
  const payload = await readSealedPayload(id);
  return { metadata, payload };
}

// ─── Internals ─────────────────────────────────────────────────────────────

async function readSealedPayload(nodeId: string): Promise<SecretPayload> {
  const [row] = await db
    .select({ ciphertext: secrets.ciphertext })
    .from(secrets)
    .where(eq(secrets.nodeId, nodeId))
    .limit(1);
  if (!row) return { note: '', fields: [] };
  const json = open(row.ciphertext, aadFor(nodeId));
  try {
    const parsed = JSON.parse(json) as Partial<SecretPayload>;
    return {
      note: typeof parsed.note === 'string' ? parsed.note : '',
      fields: Array.isArray(parsed.fields) ? sanitiseFields(parsed.fields) : [],
    };
  } catch {
    // Corrupt payload — fail closed so the user sees an empty form
    // rather than a partial reveal that misleads them.
    return { note: '', fields: [] };
  }
}

function aadFor(nodeId: string): string {
  return `secret:${nodeId}`;
}

function sanitiseFields(fields: SecretField[]): SecretField[] {
  return fields
    .filter((f) => f && typeof f.label === 'string' && typeof f.value === 'string')
    .map((f) => ({
      label: f.label.trim().slice(0, 80),
      value: f.value.slice(0, 8000),
    }))
    .filter((f) => f.label.length > 0 || f.value.length > 0)
    .slice(0, 32);
}

function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t || t.length > 40 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}
