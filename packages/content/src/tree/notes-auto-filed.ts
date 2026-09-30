/**
 * Notes / Auto-filed / Assistant: where the assistant's conversation digests
 * live (docs/folder-tree.md). They are notes the summarizer writes on its own,
 * so, like Files' Auto-filed, they sit in one admin-only system folder whose
 * name is locked and which cannot be moved, since the summarizer finds it by
 * its path.
 *
 * Digests were written at the path `assistant`, outside the notes root, so the
 * tree never showed them. `reconcileNotesAutoFiled` moves a brain's older
 * digests in once; the tree runs it when it is first asked for the notes, and
 * it costs one indexed lookup after that. Path only, so it is reversible.
 */
import { sql } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { ensureKindRoot } from './node-ops';

export const NOTES_AUTO_FILED_PATH = 'notes.auto_filed';
export const NOTES_ASSISTANT_PATH = 'notes.auto_filed.assistant';
/** Where digests were written before Auto-filed. */
const LEGACY_DIGEST_PATH = 'assistant';

const FOLDERS = [
  {
    path: NOTES_AUTO_FILED_PATH,
    title: 'Auto-filed',
    slug: 'auto-filed',
    description: 'Notes Mantle writes by itself.',
  },
  {
    path: NOTES_ASSISTANT_PATH,
    title: 'Assistant',
    slug: 'assistant',
    description: 'Conversation digests the assistant writes about its chats, by topic.',
  },
] as const;

/** Make sure Notes / Auto-filed / Assistant exists; returns its path. */
export async function ensureNotesAssistantFolder(ownerId: string): Promise<string> {
  await ensureKindRoot(ownerId, 'notes');
  for (const f of FOLDERS) {
    await db
      .insert(nodes)
      .values({
        ownerId,
        type: 'branch',
        title: f.title,
        slug: f.slug,
        path: f.path,
        data: { system: true, description: f.description },
        tags: [],
      })
      .onConflictDoNothing({
        target: [nodes.ownerId, nodes.path],
        where: sql`${nodes.type} = 'branch'`,
      });
  }
  return NOTES_ASSISTANT_PATH;
}

/** Move digests still at the old `assistant` path into Notes / Auto-filed /
 *  Assistant. Returns how many moved (0, after the first run). */
export async function reconcileNotesAutoFiled(ownerId: string): Promise<number> {
  const waiting = (await db.execute(sql`
    select 1 from nodes
     where owner_id = ${ownerId} and type = 'note' and path <@ ${LEGACY_DIGEST_PATH}::ltree
     limit 1`)) as unknown as unknown[];
  if (!waiting.length) return 0;
  await ensureNotesAssistantFolder(ownerId);
  const moved = (await db.execute(sql`
    update nodes set path = ${NOTES_ASSISTANT_PATH}::ltree
     where owner_id = ${ownerId} and type = 'note' and path <@ ${LEGACY_DIGEST_PATH}::ltree
     returning id`)) as unknown as unknown[];
  return moved.length;
}
