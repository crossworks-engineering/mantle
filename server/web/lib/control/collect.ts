/**
 * The Control Center's part of a submission sent to IT (plan page
 * 5559936a), the control service's own sweep (workers/control.ts).
 * CC code: only the control service loads it.
 *
 *  1. `list` the box's new submissions (at most 10). For each one the CC
 *     does not hold yet (the box id and the task id find it), fetch its
 *     files one at a time (`file`), each held to the task file type list and
 *     the 10 MB cap, and make the copy in the CC's Admin workspace
 *     (makeReceivedCopy, the same as a local Send to Admin). Then mark them
 *     `collected` on the box.
 *  2. Send each reply a CC Admin wrote on a copy from this box and the box
 *     has not had (`reply`), and note it sent.
 *
 * A box that fails a step keeps its submissions for the next run: nothing
 * is marked collected that the CC does not hold. One submission that fails
 * does not hold back the others. About 50 MB of files from one box in one
 * sweep. The sweep has its own timer, so it never holds back a ban.
 */
import type { KeyObject } from 'node:crypto';
import { z } from 'zod';
import { db, nodes, sql } from '@mantle/db';
import { makeReceivedCopy } from '@mantle/content';
import {
  SUBMISSION_KINDS,
  SUBMISSION_NOTE_MAX,
  SUBMISSION_VERSION_MAX,
} from '@mantle/client-types/task-submissions';
import {
  TASK_FILE_MAX_BYTES,
  TASK_FILES_MAX,
  isTaskFileType,
} from '@mantle/client-types/task-files';
import { listControlBoxes, type ControlBoxRow } from '@mantle/db/control-center';
import { log } from '@mantle/tracing';
import { errorMessage } from '@mantle/std';
import { loadAnchorId } from '@/lib/auth/login-row';
import { callBox } from './run';
import { cut } from './submissions';

const SUBMISSIONS_PER_LIST = 10;
const REPLIES_PER_RUN = 20;
/** The most file bytes the CC takes from one box in one run. */
const BYTES_PER_RUN = 50 * 1024 * 1024;
/** A 10 MB file in base64, with room for the JSON around it. */
export const FILE_REPLY_CAP_BYTES = Math.ceil((TASK_FILE_MAX_BYTES * 4) / 3) + 64 * 1024;

const ListReply = z.object({
  submissions: z
    .array(
      z.object({
        taskId: z.string().uuid(),
        kind: z.enum(SUBMISSION_KINDS),
        title: z.string().max(200),
        body: z.string().max(50_000),
        sentAt: z.string().max(40),
        by: z.object({ name: z.string().max(200), email: z.string().max(320) }),
        files: z
          .array(
            z.object({
              id: z.string().uuid(),
              filename: z.string().max(255),
              sizeBytes: z.number().int().min(0),
            }),
          )
          .max(TASK_FILES_MAX),
      }),
    )
    .max(SUBMISSIONS_PER_LIST),
});
const FileReply = z.union([
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), filename: z.string().max(255), base64: z.string() }),
]);
const ReplyAnswer = z.object({ delivered: z.boolean() });

/** The box's name on the CC copy: its label, else its host. */
function boxName(box: SweepBox): string {
  return cut(box.label?.trim() || new URL(box.url).host, 80);
}

/** Does the CC hold a copy of this box's task? */
async function holds(boxId: string, taskId: string): Promise<boolean> {
  const rows = await db.execute(sql`select 1 from ${nodes}
    where ${nodes.type} = 'task'
      and ${nodes.data} -> 'submission' ->> 'side' = 'received'
      and ${nodes.data} -> 'submission' -> 'from' -> 'box' ->> 'id' = ${boxId}
      and ${nodes.data} -> 'submission' -> 'from' ->> 'taskId' = ${taskId}
    limit 1`);
  return (rows as unknown as unknown[]).length > 0;
}

/** One submission's files, one call each, held to the CC's own caps: a
 *  file that does not fit stays on the box. */
async function fetchFiles(
  key: KeyObject,
  box: SweepBox,
  s: z.infer<typeof ListReply>['submissions'][number],
  budget: { left: number },
): Promise<{ filename: string; bytes: Buffer }[]> {
  const files: { filename: string; bytes: Buffer }[] = [];
  for (const f of s.files) {
    // Over the cap by its listed size: it stays on the box, never fetched.
    if (f.sizeBytes > TASK_FILE_MAX_BYTES) continue;
    const got = FileReply.safeParse(
      await callBox(
        key,
        box.url,
        'submissions',
        { do: 'file', taskId: s.taskId, fileId: f.id },
        { maxBytes: FILE_REPLY_CAP_BYTES, long: true },
      ),
    );
    if (!got.success) throw new Error('bad-reply');
    if (!got.data.found) continue;
    const bytes = Buffer.from(got.data.base64, 'base64');
    if (!isTaskFileType(got.data.filename) || bytes.byteLength > TASK_FILE_MAX_BYTES) continue;
    if (bytes.byteLength === 0) continue;
    // The budget took the listed size; a file bigger than it said takes
    // the rest too.
    budget.left -= Math.max(0, bytes.byteLength - f.sizeBytes);
    files.push({ filename: got.data.filename, bytes });
  }
  return files;
}

async function collect(
  key: KeyObject,
  box: SweepBox,
  anchor: string,
  deadline: number,
): Promise<number> {
  const listed = ListReply.safeParse(await callBox(key, box.url, 'submissions', { do: 'list' }));
  if (!listed.success) throw new Error('bad-reply');
  const held: string[] = [];
  // At most BYTES_PER_RUN of files from one box in one run: the rest waits
  // for the next run (the CC's disk serves every box).
  const budget = { left: BYTES_PER_RUN };
  for (const s of listed.data.submissions) {
    if (Date.now() > deadline) break;
    // The listed sizes, taken from the budget before the fetch (a failure
    // counts too): one that does not fit waits for the next run. The first
    // of a run always goes, so a 50 MB one is never stuck.
    const size = s.files.reduce(
      (n, f) => n + (f.sizeBytes > TASK_FILE_MAX_BYTES ? 0 : f.sizeBytes),
      0,
    );
    if (budget.left < BYTES_PER_RUN && size > budget.left) break;
    budget.left -= size;
    try {
      if (!(await holds(box.id, s.taskId))) {
        const files = await fetchFiles(key, box, s, budget);
        await makeReceivedCopy(anchor, {
          kind: s.kind,
          title: `${boxName(box)}: ${s.title}`.slice(0, 200),
          body: s.body,
          from: { box: { id: box.id, name: boxName(box) }, taskId: s.taskId, by: s.by },
          files,
        });
      }
      held.push(s.taskId);
    } catch (err) {
      // One submission that fails waits for the next run; the others go on.
      log('control').warn(`box ${box.id} submission ${s.taskId}: ${errorMessage(err)}`);
    }
  }
  if (held.length) await callBox(key, box.url, 'submissions', { do: 'collected', taskIds: held });
  return held.length;
}

async function sendReplies(key: KeyObject, box: SweepBox): Promise<number> {
  const rows = (await db.execute(sql`select ${nodes.id} as id,
      ${nodes.data} -> 'submission' -> 'from' ->> 'taskId' as "taskId",
      ${nodes.data} -> 'submission' -> 'reply' as reply
    from ${nodes}
    where ${nodes.type} = 'task'
      and ${nodes.data} -> 'submission' ->> 'side' = 'received'
      and ${nodes.data} -> 'submission' -> 'from' -> 'box' ->> 'id' = ${box.id}
      and ${nodes.data} -> 'submission' ? 'reply'
      and not (${nodes.data} -> 'submission' ? 'replySentAt')
    limit ${REPLIES_PER_RUN}`)) as unknown as {
    id: string;
    taskId: string;
    reply: { note: string; version: string; by: string };
  }[];
  let sent = 0;
  for (const r of rows) {
    const answer = ReplyAnswer.safeParse(
      await callBox(key, box.url, 'submissions', {
        do: 'reply',
        taskId: r.taskId,
        note: String(r.reply.note).slice(0, SUBMISSION_NOTE_MAX),
        version: String(r.reply.version).slice(0, SUBMISSION_VERSION_MAX),
        by: String(r.reply.by).slice(0, 200),
      }),
    );
    if (!answer.success) throw new Error('bad-reply');
    // Delivered, or the box's task took a reply before (or is gone): the
    // reply is never sent twice.
    await db
      .update(nodes)
      .set({
        data: sql`jsonb_set(${nodes.data}, '{submission,replySentAt}', to_jsonb(${new Date().toISOString()}::text))`,
      })
      .where(sql`${nodes.id} = ${r.id}`);
    sent++;
  }
  return sent;
}

/** How long one sweep may spend on collects: no new submission starts
 *  after it (one that started finishes: at most 5 file calls, each with its
 *  own timeout). */
const COLLECT_MS = 60_000;

/** A box as the sweep needs it. */
type SweepBox = Pick<ControlBoxRow, 'id' | 'url' | 'label'>;

/**
 * One submissions sweep (the control service's own timer, every 5 minutes,
 * apart from the ban runs, which it never holds back): for each box whose
 * last run answered, one box at a time (a box's files are held in memory
 * until its copy is made), its collect within COLLECT_MS of the sweep, then
 * its replies. Never throws: a failure waits for the next sweep.
 */
export async function runSubmissionsSweep(key: KeyObject): Promise<void> {
  const boxes: SweepBox[] = (await listControlBoxes()).filter(
    (b) => b.lastOkAt !== null && b.lastReason === null,
  );
  if (boxes.length === 0) return;
  const anchor = await loadAnchorId().catch(() => null);
  if (!anchor) return;
  const deadline = Date.now() + COLLECT_MS;
  for (const box of boxes) {
    const got = await collect(key, box, anchor, deadline).catch((err) => {
      log('control').warn(`box ${box.id} submissions: ${errorMessage(err)}`);
      return 0;
    });
    const sent = await sendReplies(key, box).catch((err) => {
      log('control').warn(`box ${box.id} replies: ${errorMessage(err)}`);
      return 0;
    });
    if (got || sent)
      log('control').info(`box ${box.id}: ${got} submissions in, ${sent} replies out`);
  }
}
