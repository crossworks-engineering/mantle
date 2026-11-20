/**
 * Fleet chat phase 1 (plan page f2f19c7b, sections 2 to 4): group handles
 * and the three fixed intake forms. The app and the MCP tools read the same
 * rules and the same questions from here. Pure: no imports but the kinds,
 * so a browser bundle takes it.
 */
import { SUBMISSION_KINDS, type SubmissionKind } from './task-submissions';

/** A handle: 2 to 30 characters, lowercase letters, digits and dashes, no
 *  dash first or last (the column's check, 0394). Shown as `@bugs`. */
export const MESSENGER_HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])$/;

/** Words no group may take as its handle. The box also refuses the slugs
 *  of its own agents. */
export const MESSENGER_HANDLE_RESERVED: readonly string[] = [
  'all',
  'here',
  'everyone',
  'admin',
  'system',
  'it',
];

/** The most handles (and IT desks) one message may name. */
export const MESSENGER_HANDLES_PER_MESSAGE = 3;

/** A handle as typed (`@Bugs `), as stored (`bugs`); null when it is no
 *  handle by the format rule. */
export function normalizeHandle(raw: string): string | null {
  const h = raw.trim().replace(/^@/, '').toLowerCase();
  return MESSENGER_HANDLE_RE.test(h) ? h : null;
}

/** The forms a group may ask for: the three Send to IT kinds. */
export const MESSENGER_INTAKE_KINDS = SUBMISSION_KINDS;
export type MessengerIntakeKind = SubmissionKind;

export type MessengerIntakeQuestion = {
  /** The key an answer is given under (MCP `answers`). */
  key: string;
  /** The question, as the form shows it. */
  label: string;
};

/** The three fixed forms (plan section 4). There is no form editor. */
export const MESSENGER_INTAKE_FORMS: Readonly<
  Record<MessengerIntakeKind, readonly MessengerIntakeQuestion[]>
> = {
  bug: [
    { key: 'did', label: 'What did you do?' },
    { key: 'happened', label: 'What happened?' },
    { key: 'expected', label: 'What did you expect?' },
  ],
  feature: [
    { key: 'need', label: 'What do you need?' },
    { key: 'who', label: 'Who uses it, and how often?' },
  ],
  request: [{ key: 'need', label: 'What do you need, and by when?' }],
};

/** Is `v` an intake kind? */
export function isMessengerIntakeKind(v: unknown): v is MessengerIntakeKind {
  return typeof v === 'string' && (MESSENGER_INTAKE_KINDS as readonly string[]).includes(v);
}

/** The longest answer to one question. */
export const MESSENGER_INTAKE_ANSWER_MAX = 2000;

/**
 * The text of a filled form: each question in bold with its answer under
 * it, in the form's order, then the added lines (the app version, the box
 * version, the page and such, each one `Label: value`). A question with no
 * answer is left out. Answers under keys the form does not have are left
 * out too (the caller's check names them first).
 */
export function intakeText(
  kind: MessengerIntakeKind,
  answers: Readonly<Record<string, string>>,
  added: readonly { label: string; value: string }[] = [],
): string {
  const parts: string[] = [];
  for (const q of MESSENGER_INTAKE_FORMS[kind]) {
    const a = (answers[q.key] ?? '').trim();
    if (a) parts.push(`**${q.label}**\n${a}`);
  }
  const lines = added
    .map((l) => ({ label: l.label.trim(), value: l.value.trim() }))
    .filter((l) => l.label && l.value)
    .map((l) => `${l.label}: ${l.value}`);
  if (lines.length) parts.push(lines.join('\n'));
  return parts.join('\n\n');
}

/** The IT desks a box linked to a Control Center shows in its @ list
 *  (plan section 7, phase 1): one for each Send to IT kind. A send to a
 *  desk is a Send to IT task. */
export const IT_DESKS: readonly { handle: string; kind: MessengerIntakeKind }[] = [
  { handle: 'bugs', kind: 'bug' },
  { handle: 'feature', kind: 'feature' },
  { handle: 'requests', kind: 'request' },
];
