/**
 * Secrets surface: a workspace kind since 0400 (owner, 2026-11-26: people
 * share passwords, .env files and logins with each other, securely; no app
 * or agent reads a value). Two rows:
 *
 *   - `nodes` row (type='secret'): plaintext metadata (title, description,
 *     tags, kind) that the extractor and search may see. Its home and
 *     grants say who reads it, as for a note.
 *   - `secrets` row (sealed bytea): AES-256-GCM ciphertext of the
 *     {note, fields} payload, AAD `secret:<node_id>`.
 *
 * Every call runs in the caller's own scope, like the notes surface. The
 * write role holds no right on the secrets table: a value goes in through
 * mantle_secret_put (the scope may edit the secret) and comes out through
 * mantle_secret_sealed (the scope reads the secret), both 0400. Only
 * `revealSecret` opens a sealed value, and only the reveal route calls it,
 * which logs each reveal first.
 *
 * Security invariants:
 *   - `listSecrets` / `getSecretMetadata` never return ciphertext or fields.
 *   - `revealSecret` is the ONLY entry point that decrypts.
 *   - New secrets land under the `secrets` root, which the extractor reads
 *     as metadata only (type='secret': title, kind, description, tags).
 */
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  db,
  nodes,
  changedFields,
  headsOrSpace,
  markContentChanged,
  withDeadlockRetry,
  withNodeDeleteHeads,
  withNodeInsertHeads,
  type Node,
} from '@mantle/db';
import { open, seal } from '@mantle/crypto';
import { asKindRootRepair } from './kind-root';
import { dedupeTags } from './tags';

/** ltree root label for all secrets. Not host-mirrored: Postgres only. */
export const SECRETS_ROOT_LABEL = 'secrets';

/** Kinds are a hint for the UI and filters. They do not constrain the
 *  field shape: each secret carries any {label, value} fields plus a note
 *  (an .env file goes in the note, kind 'env'). */
export const SECRET_KINDS = [
  'password',
  'token',
  'server',
  'card',
  'env',
  'note',
  'other',
] as const;
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

/** The `secrets` root, made the first time a secret is added: a kind root,
 *  as every kind's (kind-root.ts). */
async function ensureRoot(ownerId: string): Promise<void> {
  await asKindRootRepair(() =>
    headsOrSpace(
      (f) =>
        withDeadlockRetry(() =>
          withNodeInsertHeads(ownerId, [{ type: 'branch', path: SECRETS_ROOT_LABEL }], f),
        ),
      (tx) => insertRoot(tx, ownerId),
    ),
  );
}

/** @heads-held by ensureRoot (through headsOrSpace). */
async function insertRoot(tx: Pick<typeof db, 'insert'>, ownerId: string): Promise<void> {
  await tx
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

/** The secrets the caller reads (its scope's row rules), newest first. */
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

/** One secret's metadata, or null when the caller does not read it. */
export async function getSecretMetadata(ownerId: string, id: string): Promise<SecretRow | null> {
  const [row] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'secret')))
    .limit(1);
  return row ? nodeToRow(row) : null;
}

/** All tags in use on the secrets the caller reads, by frequency. */
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

/** Make a secret in the caller's scope: it lands where the caller's create
 *  home says (?ws=, else its private workspace), as a note does. */
export async function createSecret(ownerId: string, input: CreateSecretInput): Promise<SecretRow> {
  await ensureRoot(ownerId);
  const payload: SecretPayload = {
    note: input.note ?? '',
    fields: sanitiseFields(input.fields),
  };
  const data = {
    description: (input.description ?? '').slice(0, 4000),
    kind: input.kind,
    has_note: payload.note.trim().length > 0,
    field_count: payload.fields.length,
  };

  // The node and its sealed value in one transaction, the secrets folder's
  // head first. No outside effects, so a retry is safe.
  const [inserted] = await headsOrSpace<Node[]>(
    (f) =>
      withDeadlockRetry(() =>
        withNodeInsertHeads(ownerId, [{ type: 'secret', path: SECRETS_ROOT_LABEL }], f),
      ),
    async (tx) => {
      const rows = await tx
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
      const row = rows[0];
      if (row) await putSealed(tx, row.id, payload);
      return rows;
    },
  );
  if (!inserted) throw new Error('createSecret: insert returned no row');
  return nodeToRow(inserted);
}

export type UpdateSecretInput = Partial<CreateSecretInput>;

/** Change a secret the caller may edit (the route's item check and the
 *  database's edit check). Null when the caller does not read it. */
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

  // Rewrite the sealed value only when the note or the fields change: a
  // rename leaves it alone.
  const wantsBlobRewrite = input.note !== undefined || input.fields !== undefined;
  let nextPayload: SecretPayload | null = null;
  if (wantsBlobRewrite) {
    const existing =
      input.note !== undefined && input.fields !== undefined
        ? { note: '', fields: [] }
        : await readSealedPayload(id);
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
  const title =
    input.title !== undefined ? input.title.trim().slice(0, 200) || 'Untitled secret' : node.title;
  const tags = input.tags !== undefined ? dedupeTags(input.tags) : node.tags;
  // The metadata the extractor reads (title, description, kind, tags; the
  // kind registry's `indexed`), compared by value. The sealed note and
  // fields never reach the extractor.
  const changed = changedFields({
    title: [node.title, title],
    description: [oldData.description, newData.description],
    kind: [oldData.kind, newData.kind],
    tags: [node.tags, tags],
  });

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(nodes)
      .set({
        ...(input.title !== undefined ? { title } : {}),
        ...(input.tags !== undefined ? { tags } : {}),
        data: newData,
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, id))
      .returning();
    if (!row) return row;
    if (nextPayload) await putSealed(tx, id, nextPayload);
    return (await markContentChanged(tx, { id, type: 'secret' }, changed)) ?? row;
  });
  if (!updated) throw new Error('updateSecret: update returned no row');
  return nodeToRow(updated);
}

/** Delete a secret (the route asks `manage`; the database its delete rule).
 *  The cascade drops the sealed row. False when the caller does not read it. */
export async function deleteSecret(ownerId: string, id: string): Promise<boolean> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'secret')))
    .limit(1);
  if (!node) return false;
  await headsOrSpace(
    (f) => withDeadlockRetry(() => withNodeDeleteHeads([id], f)),
    (tx) => tx.delete(nodes).where(eq(nodes.id, id)),
  );
  return true;
}

/**
 * Decrypt and return the {note, fields} payload of a secret the caller
 * reads. The reveal route logs the reveal before it calls this. This is the
 * ONLY function that returns plaintext fields: keep it that way.
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

/** The sealed value through its one door (0400): null when there is none
 *  or the scope does not read the secret. */
async function readSealedPayload(nodeId: string): Promise<SecretPayload> {
  const rows = (await db.execute(
    sql`select mantle_secret_sealed(${nodeId}::uuid) as ciphertext`,
  )) as unknown as { ciphertext: Buffer | null }[];
  const ciphertext = rows[0]?.ciphertext ?? null;
  if (!ciphertext) return { note: '', fields: [] };
  const json = open(ciphertext, aadFor(nodeId));
  try {
    const parsed = JSON.parse(json) as Partial<SecretPayload>;
    return {
      note: typeof parsed.note === 'string' ? parsed.note : '',
      fields: Array.isArray(parsed.fields) ? sanitiseFields(parsed.fields) : [],
    };
  } catch {
    // Corrupt payload: fail closed, an empty form, never a partial reveal.
    return { note: '', fields: [] };
  }
}

/** Seal `payload` for secret `nodeId` and store it through its one door
 *  (0281, 0400): made or replaced, only for a secret the scope may edit. */
async function putSealed(
  tx: Pick<typeof db, 'execute'>,
  nodeId: string,
  payload: SecretPayload,
): Promise<void> {
  const sealed = seal(JSON.stringify(payload), aadFor(nodeId));
  await tx.execute(
    sql`select mantle_secret_put(${nodeId}::uuid, ${sealed.ciphertext}::bytea, ${sealed.keyVersion})`,
  );
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
