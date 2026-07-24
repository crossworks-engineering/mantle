import { describe, expect, it } from 'vitest';
import {
  ASK_HUMAN_FORM_LIMITS,
  isQuestionRow,
  parseForm,
  questionPreview,
  type PendingRow,
} from './types';

/**
 * `args.form` arrives from a MODEL-AUTHORED plan by way of the engine. The
 * plan parser validates it on the way in, but rows predate parser changes and
 * a brain can be answered by an older/newer UI — so the renderer's parse must
 * degrade to `null` (the free-text path still answers the question) rather
 * than throw inside a render and blank the approvals screen.
 */
const row = (args: Record<string, unknown>, extra: Partial<PendingRow> = {}): PendingRow => ({
  id: 'row-1',
  toolSlug: 'ask_human',
  args,
  status: 'pending',
  agentId: null,
  traceId: null,
  result: null,
  error: null,
  createdAt: new Date().toISOString(),
  decidedAt: null,
  executedAt: null,
  ...extra,
});

describe('parseForm', () => {
  it('reads a well-formed questionnaire', () => {
    const form = parseForm({
      questions: [
        {
          id: 'env',
          header: 'Environment',
          question: 'Which environment?',
          options: [{ label: 'dev' }, { label: 'prod', description: 'live traffic' }],
          multi_select: true,
          allow_other: false,
        },
      ],
    });
    expect(form?.questions[0]).toEqual({
      id: 'env',
      header: 'Environment',
      question: 'Which environment?',
      options: [{ label: 'dev' }, { label: 'prod', description: 'live traffic' }],
      multi_select: true,
      allow_other: false,
    });
  });

  it('accepts string options and defaults allow_other ON', () => {
    const form = parseForm({ questions: [{ question: 'Pick', options: ['a', 'b'] }] });
    expect(form?.questions[0]?.options).toEqual([{ label: 'a' }, { label: 'b' }]);
    // An absent flag must not strand the operator with no way to answer.
    expect(form?.questions[0]?.allow_other).toBe(true);
    expect(form?.questions[0]?.id).toBe('q1');
  });

  it('derives the id EXACTLY as the server does (answers are keyed by it)', () => {
    // The server's fallback is explicit id → slugified header → positional.
    // A client that derived it differently would submit answers under an id
    // the engine cannot match, and validation would reject a correct answer.
    const form = parseForm({
      questions: [
        { header: 'Target env', question: 'Which?', options: ['a'] },
        { id: 'explicit', header: 'Ignored', question: 'Which?', options: ['a'] },
        { question: 'No header', options: ['a'] },
      ],
    });
    expect(form?.questions.map((q) => q.id)).toEqual(['target-env', 'explicit', 'q3']);
  });

  it('renders no more questions than the API will accept', () => {
    // Showing a 5-question form the route 400s on submit gives the operator
    // no way to succeed.
    const form = parseForm({
      questions: Array.from({ length: 6 }, (_, i) => ({ question: `q${i}`, options: ['a'] })),
    });
    expect(form?.questions).toHaveLength(ASK_HUMAN_FORM_LIMITS.maxQuestions);
  });

  it('returns null for shapes that are not a form', () => {
    expect(parseForm(undefined)).toBeNull();
    expect(parseForm(null)).toBeNull();
    expect(parseForm('form')).toBeNull();
    expect(parseForm([])).toBeNull();
    expect(parseForm({})).toBeNull();
    expect(parseForm({ questions: [] })).toBeNull();
    expect(parseForm({ questions: 'nope' })).toBeNull();
  });

  it('skips malformed questions instead of failing the whole form', () => {
    const form = parseForm({
      questions: [
        { options: ['x'] }, // no question text — dropped
        { question: 'Real one', options: [{ description: 'no label' }, 42, 'ok'] },
      ],
    });
    expect(form?.questions).toHaveLength(1);
    expect(form?.questions[0]?.question).toBe('Real one');
    // Only the option that actually had a label survives.
    expect(form?.questions[0]?.options).toEqual([{ label: 'ok' }]);
  });

  it('returns null when every question is malformed', () => {
    expect(parseForm({ questions: [{ options: ['x'] }, {}] })).toBeNull();
  });

  it('tolerates a question with no options (pure free-text)', () => {
    const form = parseForm({ questions: [{ question: 'Why?' }] });
    expect(form?.questions[0]?.options).toEqual([]);
    expect(form?.questions[0]?.allow_other).toBe(true);
  });
});

describe('isQuestionRow', () => {
  it('matches the two human-answerable slugs only', () => {
    expect(isQuestionRow(row({}))).toBe(true);
    expect(isQuestionRow(row({}, { toolSlug: 'run_budget' }))).toBe(true);
    expect(isQuestionRow(row({}, { toolSlug: 'email_send' }))).toBe(false);
  });
});

describe('questionPreview', () => {
  it('collapses whitespace and truncates', () => {
    expect(questionPreview(row({ question: 'Send   the\n\ninvoice?' }))).toBe('Send the invoice?');
    const long = questionPreview(row({ question: 'x'.repeat(200) }), 20);
    expect(long).toHaveLength(20);
    expect(long.endsWith('…')).toBe(true);
  });

  it('falls back per slug when the row carries no question', () => {
    expect(questionPreview(row({}))).toBe('A run needs an answer.');
    expect(questionPreview(row({}, { toolSlug: 'run_budget' }))).toBe(
      'A run is paused on its budget.',
    );
  });
});
