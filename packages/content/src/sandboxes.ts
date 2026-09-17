import { and, desc, eq, or } from 'drizzle-orm';
import { db, sandboxes, type Sandbox, type NewSandbox } from '@mantle/db';
import { UUID_RE } from '@mantle/std';

/**
 * Sandbox row CRUD — the DB half of the CLI-sandboxes feature. The container
 * half lives in the `sandboxd` supervisor (server/sandboxd), which the tool
 * layer calls over HTTP; this module never touches Docker. Rows are the
 * owner-scoped registry (name → sandbox); the durable work product is the
 * per-sandbox /files host directory, which this module deliberately does not
 * manage — deleting a row frees the name but never the files.
 */

export const SANDBOX_NAME_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

export async function createSandboxRow(input: NewSandbox): Promise<Sandbox> {
  const [row] = await db.insert(sandboxes).values(input).returning();
  return row!;
}

export async function listSandboxes(ownerId: string): Promise<Sandbox[]> {
  return db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.ownerId, ownerId))
    .orderBy(desc(sandboxes.lastUsedAt));
}

/** Resolve `ref` as a sandbox id (uuid) or name, scoped to the owner. */
export async function getSandboxByRef(ownerId: string, ref: string): Promise<Sandbox | null> {
  const isUuid = UUID_RE.test(ref);
  const [row] = await db
    .select()
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.ownerId, ownerId),
        isUuid ? or(eq(sandboxes.id, ref), eq(sandboxes.name, ref)) : eq(sandboxes.name, ref),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function touchSandbox(id: string): Promise<void> {
  await db.update(sandboxes).set({ lastUsedAt: new Date() }).where(eq(sandboxes.id, id));
}

export async function setSandboxStatus(id: string, status: Sandbox['status']): Promise<void> {
  await db.update(sandboxes).set({ status }).where(eq(sandboxes.id, id));
}

export async function deleteSandboxRow(id: string): Promise<void> {
  await db.delete(sandboxes).where(eq(sandboxes.id, id));
}
