/**
 * The stored `data.submission` block of a task, read back as the wire shape
 * (@mantle/client-types/task-submissions). Pure: tasks.ts reads it into
 * every row, and submissions.ts writes it. A block that does not fit is
 * absent: it is the system's own, so a misfit is never shown half.
 */
import {
  SUBMISSION_KINDS,
  SUBMIT_TARGETS,
  type SubmissionReply,
  type TaskSubmission,
} from '@mantle/client-types/task-submissions';

const str = (v: unknown): v is string => typeof v === 'string';
const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function replyOf(v: unknown): SubmissionReply | undefined {
  const r = rec(v);
  if (!r || r.status !== 'done' || !str(r.note) || !str(r.version) || !str(r.by) || !str(r.at)) {
    return undefined;
  }
  return { status: 'done', note: r.note, version: r.version, by: r.by, at: r.at };
}

/** The submission block of a task's data, or undefined. */
export function submissionOf(data: Record<string, unknown>): TaskSubmission | undefined {
  const s = rec(data.submission);
  if (!s || !(SUBMISSION_KINDS as readonly unknown[]).includes(s.kind)) return undefined;
  const kind = s.kind as TaskSubmission['kind'];
  const reply = replyOf(s.reply);
  if (s.side === 'sent') {
    if (!(SUBMIT_TARGETS as readonly unknown[]).includes(s.to) || !str(s.sentAt)) return undefined;
    return {
      side: 'sent',
      kind,
      to: s.to as 'admin' | 'it',
      sentAt: s.sentAt,
      ...(str(s.copyId) ? { copyId: s.copyId } : {}),
      ...(str(s.collectedAt) ? { collectedAt: s.collectedAt } : {}),
      ...(reply ? { reply } : {}),
    };
  }
  if (s.side === 'received') {
    const from = rec(s.from);
    const by = rec(from?.by);
    const box = rec(from?.box);
    if (!from || !str(from.taskId) || !by || !str(by.name) || !str(by.email)) return undefined;
    if (!str(s.receivedAt)) return undefined;
    return {
      side: 'received',
      kind,
      from: {
        box: box && str(box.id) && str(box.name) ? { id: box.id, name: box.name } : null,
        taskId: from.taskId,
        by: { name: by.name, email: by.email },
      },
      receivedAt: s.receivedAt,
      ...(reply ? { reply } : {}),
      ...(str(s.replySentAt) ? { replySentAt: s.replySentAt } : {}),
    };
  }
  return undefined;
}
