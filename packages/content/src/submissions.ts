/**
 * Submit a bug, a feature or a request (plan page 5559936a, task
 * f0c65930). One path, on a box and on a Control Center:
 *
 *  - A submission is the person's **own task** (with its files) and a
 *    **copy** where it is sent. Send to Admin makes the copy in this box's
 *    Admin workspace at once. Send to IT leaves it for the Control Center,
 *    which makes its copy in its own sweep (lib/control).
 *  - **Reply:** who may edit the copy writes one reply on it. The reply goes
 *    to the person's task, which becomes done: at once on this box, in the
 *    next sweep from a Control Center.
 *  - **A snapshot at send:** the title, the body and the files of that
 *    moment. A later edit stays on the person's task.
 *
 * Two checks: the caller may edit the task (the systemStep's item check),
 * and the block's own state (not sent before; not replied before). The
 * block (`data.submission`) is the system's: a task edit never writes it
 * (tasks.ts), so neither side forges the other's.
 */
import { and, eq, sql } from 'drizzle-orm';
import { authUsers, db, liveWorkspaceSql, nodes, systemStep, withCreateHome } from '@mantle/db';
import { readFileById } from '@mantle/files';
import {
  SUBMISSION_NOTE_MAX,
  SUBMISSION_VERSION_MAX,
  type SubmissionKind,
  type SubmissionReply,
  type SubmissionSender,
  type SubmitTarget,
  type TaskSubmission,
} from '@mantle/client-types/task-submissions';
import { ConflictError, InputError } from '@mantle/std';
import { createTask, getTask, updateTask, type TaskRow } from './tasks';
import { addTaskFile, listTaskFiles } from './task-files';
import { submissionOf } from './task-submission-shape';

export { submissionOf };

/** The submission block of a task the system reads, or null when no task
 *  has the id. */
async function blockOf(
  ownerId: string,
  taskId: string,
): Promise<{ data: Record<string, unknown>; submission: TaskSubmission | undefined } | null> {
  const [row] = await db
    .select({ data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.id, taskId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'task')))
    .limit(1);
  if (!row) return null;
  const data = (row.data ?? {}) as Record<string, unknown>;
  return { data, submission: submissionOf(data) };
}

/** Write `block` as the task's submission block, only while the task's
 *  block still equals `was` (null: none yet). False when another write came
 *  first: the caller answers 409. */
async function swapBlock(
  taskId: string,
  was: Record<string, unknown> | null,
  block: Record<string, unknown>,
): Promise<boolean> {
  const rows = await db
    .update(nodes)
    .set({
      data: sql`jsonb_set(coalesce(${nodes.data}, '{}'::jsonb), '{submission}', ${JSON.stringify(block)}::jsonb)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(nodes.id, taskId),
        was === null
          ? sql`not (coalesce(${nodes.data}, '{}'::jsonb) ? 'submission')`
          : sql`${nodes.data} -> 'submission' = ${JSON.stringify(was)}::jsonb`,
      ),
    )
    .returning({ id: nodes.id });
  return rows.length === 1;
}

/** Take a task's submission block off (an undo after a failed copy). */
async function dropBlock(taskId: string): Promise<void> {
  await db
    .update(nodes)
    .set({ data: sql`${nodes.data} - 'submission'` })
    .where(eq(nodes.id, taskId));
}

/** Who a login is, as the other side shows it (the system's read). A
 *  call with no login (system work) is "Mantle". */
export async function senderOf(loginId: string | null): Promise<SubmissionSender> {
  if (loginId) {
    const [u] = await db
      .select({ email: authUsers.email, name: authUsers.displayName })
      .from(authUsers)
      .where(eq(authUsers.id, loginId))
      .limit(1);
    if (u) return { name: (u.name || u.email).slice(0, 200), email: u.email.slice(0, 320) };
  }
  return { name: 'Mantle', email: '' };
}

/** This box's live Admin workspace id, or null (a box with none). */
async function adminWorkspace(): Promise<string | null> {
  const rows = (await db.execute(sql`
    select w."id" as id from "public"."workspaces" w
     where w."owner_id" = "public"."mantle_brain_id"() and w."is_admin"
       and ${liveWorkspaceSql('w')}`)) as unknown as { id: string }[];
  return rows.length === 1 ? rows[0]!.id : null;
}

export type ReceivedFrom = {
  box: { id: string; name: string } | null;
  taskId: string;
  by: SubmissionSender;
};

/**
 * Make the copy of a submission in this box's Admin workspace: a task with
 * the same title and body, the kind as a tag, the received block, and a
 * copy of each file. The system's work (no caller check here): the local
 * send below, and the Control Center's sweep. The copy's id.
 */
export async function makeReceivedCopy(
  ownerId: string,
  args: {
    kind: SubmissionKind;
    title: string;
    body: string;
    from: ReceivedFrom;
    files: { filename: string; bytes: Buffer }[];
  },
): Promise<string> {
  const ws = await adminWorkspace();
  if (!ws) throw new InputError('This box has no Admin workspace to send it to.');
  const block = {
    side: 'received',
    kind: args.kind,
    from: args.from,
    receivedAt: new Date().toISOString(),
  };
  const copy = await withCreateHome({ createWs: ws, privateWs: null }, () =>
    createTask(ownerId, {
      title: args.title,
      body: args.body,
      tags: [args.kind],
      extraData: { submission: block },
    }),
  );
  for (const f of args.files) {
    await addTaskFile({ ownerId, taskId: copy.id, filename: f.filename, bytes: f.bytes });
  }
  return copy.id;
}

/** The files of a task with their bytes (the system's read). */
export async function taskFilesWithBytes(
  ownerId: string,
  taskId: string,
): Promise<{ id: string; filename: string; bytes: Buffer }[]> {
  const out: { id: string; filename: string; bytes: Buffer }[] = [];
  for (const f of await listTaskFiles(ownerId, taskId)) {
    const res = await readFileById({ ownerId, fileId: f.id });
    if (res) out.push({ id: f.id, filename: f.filename, bytes: res.bytes });
  }
  return out;
}

/**
 * Send a task as a bug, a feature or a request, for a caller that may edit
 * it. `admin`: the copy is made in this box's Admin workspace now. `it`:
 * the task waits for the Control Center's sweep (the route allows `it` only
 * on a box linked to one). The kind goes on the task as a tag. Null when no
 * task has the id; 409 when it was sent before.
 */
export async function submitTask(
  ownerId: string,
  taskId: string,
  args: { kind: SubmissionKind; to: SubmitTarget; byLogin: string | null },
): Promise<TaskRow | null> {
  return systemStep('submissions', { items: [taskId], need: 'edit' }, async () => {
    const task = await getTask(ownerId, taskId);
    if (!task) return null;
    const by = await senderOf(args.byLogin);
    const sent = { side: 'sent', kind: args.kind, to: args.to, sentAt: new Date().toISOString() };
    // The claim first, so two sends at once make one copy.
    if (!(await swapBlock(taskId, null, sent))) {
      throw new ConflictError('This task was sent already.');
    }
    if (args.to === 'admin') {
      try {
        const copyId = await makeReceivedCopy(ownerId, {
          kind: args.kind,
          title: task.title,
          body: task.body,
          from: { box: null, taskId, by },
          files: await taskFilesWithBytes(ownerId, taskId),
        });
        await swapBlock(taskId, sent, { ...sent, copyId });
      } catch (err) {
        // No copy, no sent mark: the person can send it again.
        await dropBlock(taskId);
        throw err;
      }
    }
    if (!task.tags.includes(args.kind)) {
      await updateTask(ownerId, taskId, { tags: [...task.tags, args.kind] });
    }
    return getTask(ownerId, taskId);
  });
}

/** A reply's note and version, held to their caps (InputError). */
export function replyOf(note: string, version: string, by: string): SubmissionReply {
  const n = note.trim();
  const v = version.trim();
  if (!n) throw new InputError('Write a short note for the reply.');
  if (n.length > SUBMISSION_NOTE_MAX) {
    throw new InputError(`A reply note can be at most ${SUBMISSION_NOTE_MAX} characters.`);
  }
  if (v.length > SUBMISSION_VERSION_MAX) {
    throw new InputError(`A version can be at most ${SUBMISSION_VERSION_MAX} characters.`);
  }
  return {
    status: 'done',
    note: n,
    version: v,
    by: by.slice(0, 200),
    at: new Date().toISOString(),
  };
}

/**
 * Put a reply on the person's own task (the system's work: a local reply
 * below, and the Control Center's `reply` case). The task becomes done.
 * False when the task is not a sent submission, or has a reply already.
 */
export async function deliverReply(
  ownerId: string,
  taskId: string,
  reply: SubmissionReply,
  to: SubmitTarget,
): Promise<boolean> {
  const b = await blockOf(ownerId, taskId);
  const s = b?.submission;
  if (!b || !s || s.side !== 'sent' || s.to !== to || s.reply) return false;
  const was = b.data.submission as Record<string, unknown>;
  if (!(await swapBlock(taskId, was, { ...was, reply }))) return false;
  await updateTask(ownerId, taskId, { status: 'done' });
  return true;
}

/**
 * Reply on a copy, for a caller that may edit it: the reply is written on
 * the copy, which becomes done. A copy on this box sends it to the
 * person's task at once; a Control Center's copy waits for the sweep. Null
 * when no task has the id; 400 when the task is no copy; 409 when it has a
 * reply already.
 */
export async function replyToSubmission(
  ownerId: string,
  taskId: string,
  args: { note: string; version: string; byLogin: string | null },
): Promise<TaskRow | null> {
  replyOf(args.note, args.version, ''); // the caps, before any read
  return systemStep('submissions', { items: [taskId], need: 'edit' }, async () => {
    const reply = replyOf(args.note, args.version, (await senderOf(args.byLogin)).name);
    const b = await blockOf(ownerId, taskId);
    if (!b) return null;
    const s = b.submission;
    if (!s || s.side !== 'received') {
      throw new InputError('Only a submission that arrived here takes a reply.');
    }
    if (s.reply) throw new ConflictError('This submission has a reply already.');
    const was = b.data.submission as Record<string, unknown>;
    if (!(await swapBlock(taskId, was, { ...was, reply }))) {
      throw new ConflictError('This submission has a reply already.');
    }
    await updateTask(ownerId, taskId, { status: 'done' });
    if (s.from.box === null) await deliverReply(ownerId, s.from.taskId, reply, 'admin');
    return getTask(ownerId, taskId);
  });
}
