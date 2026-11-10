/**
 * Submit a bug, a feature or a request (plan page 5559936a, task
 * f0c65930). A person sends one of their own tasks to the box's Admins
 * (`admin`), or to the Control Center (`it`) when the box has one. The
 * server keeps the block in the task's data (`data.submission`); only the
 * system writes it. Pure: no imports, so a browser bundle takes it.
 */

/** What a submission is. */
export const SUBMISSION_KINDS = ['bug', 'feature', 'request'] as const;
export type SubmissionKind = (typeof SUBMISSION_KINDS)[number];

/** Where a submission goes: this box's Admin workspace, or the Control
 *  Center (only on a box linked to one). */
export const SUBMIT_TARGETS = ['admin', 'it'] as const;
export type SubmitTarget = (typeof SUBMIT_TARGETS)[number];

/** The longest reply note. */
export const SUBMISSION_NOTE_MAX = 2000;
/** The longest version text on a reply. */
export const SUBMISSION_VERSION_MAX = 40;

/** The answer to a submission: written once, by who replies on the copy. */
export type SubmissionReply = {
  status: 'done';
  note: string;
  /** The version the fix shipped in (the reply form fills in the running
   *  version of the box where the reply is made). */
  version: string;
  /** Who replied: a display name, never an id of another box. */
  by: string;
  at: string;
};

/** Who sent it, as the receiving side shows it. */
export type SubmissionSender = { name: string; email: string };

/**
 * `data.submission` of a task, in one of two shapes:
 *  - `sent`: the person's own task. `copyId` is the Admin copy on this box
 *    (to `admin`); `collectedAt` is when the Control Center took it (to `it`).
 *  - `received`: the copy where it was sent (this box's Admin workspace, or
 *    the Control Center's). `from.box` is null for a copy on the same box.
 */
export type TaskSubmission =
  | {
      side: 'sent';
      kind: SubmissionKind;
      to: SubmitTarget;
      sentAt: string;
      copyId?: string;
      collectedAt?: string;
      reply?: SubmissionReply;
    }
  | {
      side: 'received';
      kind: SubmissionKind;
      from: { box: { id: string; name: string } | null; taskId: string; by: SubmissionSender };
      receivedAt: string;
      reply?: SubmissionReply;
      /** On the Control Center: when the reply reached the box. */
      replySentAt?: string;
    };

/** One button the submit form shows (`GET /api/tasks/submit`). */
export type SubmitButton = { to: SubmitTarget; label: string };

/** Is `v` a submission kind? */
export function isSubmissionKind(v: unknown): v is SubmissionKind {
  return typeof v === 'string' && (SUBMISSION_KINDS as readonly string[]).includes(v);
}
