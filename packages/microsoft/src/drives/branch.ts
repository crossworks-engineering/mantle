/** ltree branch helpers — a local copy of the email sync's private
 *  `ensureBranchPath` (packages/email/src/sync.ts) so Microsoft files can be
 *  placed under their account/drive branch. Kept here rather than exported from
 *  email to avoid cross-coupling two integrations. */
import { sql } from 'drizzle-orm';
import { db, nodes, type NewNode } from '@mantle/db';

/** Turn an ltree label into a human title: `shared_documents` → `Shared documents`. */
export function prettyTitle(label: string): string {
  const spaced = label.replace(/_/g, ' ').trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : label;
}

/** Idempotently create a `branch` node for `path` and every ancestor, so a file
 *  inserted at `path` has its folder chain present. Safe to call concurrently
 *  (ON CONFLICT DO NOTHING on the (owner, path) branch uniqueness). */
export async function ensureBranchPath(ownerId: string, path: string): Promise<void> {
  const segments = path.split('.');
  for (let i = 1; i <= segments.length; i++) {
    const prefix = segments.slice(0, i).join('.');
    await db
      .insert(nodes)
      .values({
        ownerId,
        type: 'branch',
        title: prettyTitle(segments[i - 1]!),
        path: prefix,
        data: {},
      } as NewNode)
      .onConflictDoNothing({ target: [nodes.ownerId, nodes.path], where: sql`${nodes.type} = 'branch'` });
  }
}
