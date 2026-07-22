/**
 * The answer-rendering half of `ask_human` (tier-2 audit fixes). Pure — no
 * database — so unlike the engine suite these run in CI.
 *
 * Both properties here exist because this text reaches the RESUME PROMPT:
 * a resumed responder acts on it, so it must name the questions the operator
 * actually saw, and it must not carry text that was never on the form.
 */
import { describe, expect, it } from 'vitest';

import { renderFormAnswers } from './human';

const FORM = {
  questions: [
    { id: 'env', header: 'Target', question: 'Which environment?' },
    { id: 'when', question: 'When may it run?' },
    { id: 'notes' },
  ] as Array<Record<string, unknown>>,
};

describe('renderFormAnswers', () => {
  it('labels each line with the question, never the bare id', () => {
    const out = renderFormAnswers(
      [
        { question: 'env', selected: ['production'] },
        { question: 'when', selected: [], other: 'after 22:00' },
      ],
      FORM,
    );
    // 'Target' is the header; 'When may it run?' falls back to the text.
    expect(out).toBe('Target: production\nWhen may it run?: Other: after 22:00');
    expect(out).not.toMatch(/\benv\b/);
  });

  it('falls back to the id when the form gives it no label', () => {
    expect(renderFormAnswers([{ question: 'notes', selected: ['x'] }], FORM)).toBe('notes: x');
  });

  it('still renders without a form (legacy rows keep working)', () => {
    expect(renderFormAnswers([{ question: 'env', selected: ['dev'] }])).toBe('env: dev');
  });

  it('joins multi-select picks and marks an unanswered question', () => {
    const out = renderFormAnswers(
      [
        { question: 'env', selected: ['a', 'b'] },
        { question: 'when', selected: [] },
      ],
      FORM,
    );
    expect(out).toBe('Target: a, b\nWhen may it run?: (no answer)');
  });

  it('caps the prose so a long answer cannot flood the prompt', () => {
    const out = renderFormAnswers(
      [{ question: 'env', selected: [], other: 'x'.repeat(9000) }],
      FORM,
    );
    expect(out).toHaveLength(4000);
  });
});
