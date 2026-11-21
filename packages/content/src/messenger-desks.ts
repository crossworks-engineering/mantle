/**
 * The IT desks of the messenger (fleet chat phase 1, milestone 3; plan
 * page f2f19c7b, section 7, decision D3 A): on a box linked to a Control
 * Center, `@bugs (IT)`, `@feature (IT)` and `@requests (IT)` are addresses
 * in the @ list. A line to a desk is a Send to IT: the person's own task
 * (the line's text and files), sent to `it` by the path that exists
 * (submitTask). The Control Center's sweep takes it within 5 minutes, and
 * its one reply comes back as a line in the first chat (messenger.ts,
 * deskAnswerLine).
 *
 * The desk words are reserved handles (MESSENGER_HANDLE_RESERVED): no local
 * group takes one. A desk starts no agent turn.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { controlCenterLabel, controlSubjectLines } from '@mantle/config';
import {
  createHomeIntent,
  currentCreateHome,
  db,
  messengerAttachments,
  systemStep,
  withCreateHome,
} from '@mantle/db';
import { getContent } from '@mantle/storage';
import { InputError, errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { IT_DESKS, type MessengerIntakeKind } from '@mantle/client-types/messenger-intake';
import { createTask, deleteTask } from './tasks';
import { addTaskFile } from './task-files';
import { submitTask } from './submissions';

export type DeskKind = MessengerIntakeKind;
export type DeskStatus = 'sent' | 'received' | 'answered';

/** Whether this box shows the IT desks: it is linked to a Control Center
 *  (the one check Send to IT asks). */
export function itDesksOn(): boolean {
  return controlSubjectLines().on;
}

/** The desks' site, the Control Center's name on this box (IT by default). */
export function deskSite(): string {
  return controlCenterLabel();
}

/** The desk a handle names (`bugs`, `@Bugs`), or null. */
export function deskOfHandle(handle: string): { handle: string; kind: DeskKind } | null {
  const h = handle.trim().replace(/^@/, '').toLowerCase();
  return IT_DESKS.find((d) => d.handle === h) ?? null;
}

/** The handle of a desk kind (`bug`: `bugs`). */
export function deskHandle(kind: DeskKind): string {
  return IT_DESKS.find((d) => d.kind === kind)!.handle;
}

/** A desk as a line shows it: `@bugs (IT)`. */
export function deskLabel(kind: DeskKind): string {
  return `@${deskHandle(kind)} (${deskSite()})`;
}

/** The site a send names, held to this box's one site: '' or the
 *  Control Center's name (any case). Else an InputError. */
export function checkDeskSite(site: string | null | undefined): void {
  const s = (site ?? '').trim();
  if (s && s.toLowerCase() !== deskSite().toLowerCase()) {
    throw new InputError(`This box knows one site, ${deskSite()}. It has no site named "${s}".`);
  }
}

/** The desks as directory rows, on a linked box only, matched by `term`
 *  (the handle, the kind or the site). */
export function deskEntries(term: string): {
  kind: 'desk';
  id: DeskKind;
  name: string;
  online: false;
  handle: string;
  intake: DeskKind;
  site: string;
}[] {
  if (!itDesksOn()) return [];
  const site = deskSite();
  const t = term.trim().replace(/^@/, '').toLowerCase();
  return IT_DESKS.filter(
    (d) => !t || d.handle.includes(t) || d.kind.includes(t) || site.toLowerCase().includes(t),
  ).map((d) => ({
    kind: 'desk' as const,
    id: d.kind,
    name: `@${d.handle} (${site})`,
    online: false as const,
    handle: d.handle,
    intake: d.kind,
    site,
  }));
}

/** The task's title: the line's first line, at most 200 characters. */
function titleOf(kind: DeskKind, body: string): string {
  const first = body
    .split('\n')
    .map((l) => l.replace(/\*\*/g, '').trim())
    .find((l) => l);
  return (first || `A ${kind} report`).slice(0, 200).replace(/[\uD800-\uDBFF]$/, '');
}

/**
 * The Send to IT task of a line to a desk: made in the caller's own scope
 * (their own task, as by hand; the database checks the create), the line's
 * text as title and body. Then the line's files as task files and the send
 * to `it` with the chat in its block, as the named step 'submissions' for
 * that one new task: the caller's scope was read before the create, so a
 * first private workspace the create made is not in it yet. Answers the
 * task's id. A failure takes the task off again: nothing is left half made.
 */
export async function deskTask(
  actor: { ownerId: string; loginId: string },
  args: { kind: DeskKind; body: string; conversationId: string; fileIds: readonly string[] },
): Promise<string> {
  if (!itDesksOn()) {
    throw new InputError('This box has no IT desks: it is not linked to a Control Center.');
  }
  // Where my task lands: the home this call has (an MCP call's), else my
  // default, as a task made by hand (a member's own private workspace).
  const home =
    currentCreateHome() ??
    (await createHomeIntent(actor.loginId, null, { ownWork: 'auto', makePrivate: true }));
  if ('refused' in home) throw new InputError(home.message);
  return withCreateHome(home, () => makeDeskTask(actor, args));
}

async function makeDeskTask(
  actor: { ownerId: string; loginId: string },
  args: { kind: DeskKind; body: string; conversationId: string; fileIds: readonly string[] },
): Promise<string> {
  const task = await createTask(actor.ownerId, {
    title: titleOf(args.kind, args.body),
    body: args.body,
  });
  try {
    await systemStep('submissions', { items: 'none', why: NEW_TASK }, () =>
      fileAndSend(actor, task.id, args),
    );
  } catch (err) {
    await undoDeskTask(actor.ownerId, task.id);
    throw err;
  }
  return task.id;
}

/** Why the step names no item: it acts on the task the same call made. */
const NEW_TASK = 'the files and the send of the task this line made in the caller scope';

async function fileAndSend(
  actor: { ownerId: string; loginId: string },
  taskId: string,
  args: { kind: DeskKind; conversationId: string; fileIds: readonly string[] },
): Promise<void> {
  if (args.fileIds.length > 0) {
    // My own unsent uploads of this chat: the send claims the same rows.
    const rows = await db
      .select({
        id: messengerAttachments.id,
        name: messengerAttachments.name,
        path: messengerAttachments.path,
      })
      .from(messengerAttachments)
      .where(
        and(
          inArray(messengerAttachments.id, [...args.fileIds]),
          eq(messengerAttachments.conversationId, args.conversationId),
          eq(messengerAttachments.uploaderLoginId, actor.loginId),
          sql`${messengerAttachments.messageId} is null`,
        ),
      );
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of args.fileIds) {
      const row = byId.get(id);
      if (!row) {
        throw new InputError(
          'Each attachment must be one you uploaded to this chat and did not send yet.',
        );
      }
      const obj = await getContent(row.path);
      const chunks: Buffer[] = [];
      for await (const c of obj.body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
      await addTaskFile({
        ownerId: actor.ownerId,
        taskId,
        filename: row.name,
        bytes: Buffer.concat(chunks),
      });
    }
  }
  await submitTask(actor.ownerId, taskId, {
    kind: args.kind,
    to: 'it',
    byLogin: actor.loginId,
    chat: { conversationId: args.conversationId },
  });
}

/** Take a desk's task off again (its line was not written), as the same
 *  step: a task left sent would reach the Control Center. */
export async function undoDeskTask(ownerId: string, taskId: string): Promise<void> {
  const off = await systemStep('submissions', { items: 'none', why: UNDO }, () =>
    deleteTask(ownerId, taskId),
  ).catch((err: unknown) => errorMessage(err));
  if (off !== true) {
    log('messenger').warn(`a desk task ${taskId} was not taken off: ${off || 'not found'}`);
  }
}

const UNDO = 'take off the task of a line to an IT desk that was not written';

/** Where each report stands, from its task's block: answered (a reply),
 *  received (the Control Center took it), else sent. `on` reads the tasks
 *  (the system's read: the chat's other readers do not read the task). */
export function deskStatusOf(block: Record<string, unknown> | null | undefined): DeskStatus {
  if (!block) return 'sent';
  if (block.reply) return 'answered';
  if (typeof block.collectedAt === 'string') return 'received';
  return 'sent';
}
