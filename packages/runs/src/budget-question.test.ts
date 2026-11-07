/**
 * The question of a run's budget pause: a card cuts long text at its end, so the
 * figures come before the title. No database.
 */
import { describe, expect, it } from 'vitest';

import { runBudgetQuestion } from './engine';

describe('runBudgetQuestion', () => {
  it('names the figures and the title, the figures first', () => {
    const question = runBudgetQuestion('Monthly report', 6_100_000, 5_000_000);
    expect(question).toContain('$6.10 of its $5.00 budget');
    expect(question).toContain('by another $5.00');
    expect(question.indexOf('$5.00')).toBeLessThan(question.indexOf('Monthly report'));
  });

  it('a long title leaves the figures in the first 600 characters', () => {
    const question = runBudgetQuestion('t'.repeat(5000), 6_100_000, 5_000_000);
    expect(question.slice(0, 600)).toContain('$6.10 of its $5.00 budget');
  });
});
