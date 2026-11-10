/**
 * The subject box's side of a submission sent to IT (plan page 5559936a):
 * the `submissions` case of the signed route (box.ts). Four fixed shapes,
 * each the system's work behind the route's signature check:
 *
 *  - `list`: up to 10 tasks sent to IT and not collected, oldest first:
 *    kind, title, body, sender, and each file's id, name and size.
 *  - `file`: one file of such a task, base64 (at most 10 MB).
 *  - `collected`: the task ids the CC holds now; they leave the list.
 *  - `reply`: the CC's reply on one task sent to IT: the task becomes done
 *    (deliverReply). A second reply is answered `delivered: false`.
 *
 * The person's task and its files stay on the box. The CC holds a copy.
 */
import { and, db, eq, inArray, nodes, sql } from '@mantle/db';
import { TASK_FILES_MAX } from '@mantle/client-types/task-files';
import { deliverReply, listTaskFiles, replyOf } from '@mantle/content';
import { readFileById } from '@mantle/files';

/** The longest body one list call carries (the task routes' own cap). */
const BODY_MAX = 50_000;

/** The most submissions one list call carries. */
export const SUBMISSIONS_PER_LIST = 10;

const sentToIt = sql`${nodes.data} -> 'submission' ->> 'side' = 'sent'
  and ${nodes.data} -> 'submission' ->> 'to' = 'it'
  and not (${nodes.data} -> 'submission' ? 'collectedAt')`;

type Listed = {
  taskId: string;
  kind: string;
  title: string;
  body: string;
  sentAt: string;
  by: { name: string; email: string };
  files: { id: string; filename: string; sizeBytes: number }[];
};

export async function listForCenter(ownerId: string): Promise<{ submissions: Listed[] }> {
  const rows = await db
    .select({ id: nodes.id, title: nodes.title, data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'task'), sentToIt))
    .orderBy(sql`${nodes.data} -> 'submission' ->> 'sentAt'`)
    .limit(SUBMISSIONS_PER_LIST);
  const out: Listed[] = [];
  for (const r of rows) {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const s = d.submission as Record<string, unknown>;
    const by = (s.by ?? {}) as Record<string, unknown>;
    const files = await listTaskFiles(ownerId, r.id);
    out.push({
      taskId: r.id,
      kind: String(s.kind),
      title: r.title.slice(0, 200),
      // The route's own caps (an agent's task_create has none on the body),
      // so one long task never spoils the CC's read of the list.
      body: (typeof d.body === 'string' ? d.body : '').slice(0, BODY_MAX),
      sentAt: String(s.sentAt),
      by: { name: String(by.name ?? ''), email: String(by.email ?? '') },
      files: files
        .slice(0, TASK_FILES_MAX)
        .map((f) => ({ id: f.id, filename: f.filename, sizeBytes: f.sizeBytes })),
    });
  }
  return { submissions: out };
}

/** One file of a task sent to IT and not collected, or `{ found: false }`. */
export async function fileForCenter(
  ownerId: string,
  taskId: string,
  fileId: string,
): Promise<{ found: false } | { found: true; filename: string; base64: string }> {
  const [task] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, taskId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'task'), sentToIt))
    .limit(1);
  if (!task) return { found: false };
  const file = (await listTaskFiles(ownerId, taskId)).find((f) => f.id === fileId);
  if (!file) return { found: false };
  const res = await readFileById({ ownerId, fileId });
  if (!res) return { found: false };
  return { found: true, filename: file.filename, base64: res.bytes.toString('base64') };
}

/** Mark tasks sent to IT as collected. The count marked. */
export async function markCollected(
  ownerId: string,
  taskIds: string[],
): Promise<{ marked: number }> {
  if (taskIds.length === 0) return { marked: 0 };
  const rows = await db
    .update(nodes)
    .set({
      data: sql`jsonb_set(${nodes.data}, '{submission,collectedAt}', to_jsonb(${new Date().toISOString()}::text))`,
    })
    .where(
      and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'task'), inArray(nodes.id, taskIds), sentToIt),
    )
    .returning({ id: nodes.id });
  return { marked: rows.length };
}

/** The CC's reply on one task sent to IT. */
export async function replyFromCenter(
  ownerId: string,
  args: { taskId: string; note: string; version: string; by: string },
): Promise<{ delivered: boolean }> {
  const reply = replyOf(args.note, args.version, args.by);
  return { delivered: await deliverReply(ownerId, args.taskId, reply, 'it') };
}
