/** lanePatchProblem: what the route and the MCP tool refuse before a save. */
import { describe, expect, it } from 'vitest';
import { lanePatchProblem } from './extraction-settings';

describe('lanePatchProblem', () => {
  it('takes a whole number in range, or null, for each setting', () => {
    expect(lanePatchProblem({ bookConcurrency: 2 })).toBeNull();
    expect(lanePatchProblem({ concurrency: 16, bookConcurrency: null })).toBeNull();
    expect(lanePatchProblem({ timeBudgetMinutes: 720 })).toBeNull();
    expect(lanePatchProblem({ concurrency: null, timeBudgetMinutes: null })).toBeNull();
  });

  it('refuses nothing to change', () => {
    expect(lanePatchProblem({})).toMatch(/nothing to change/);
    expect(lanePatchProblem({ concurrency: undefined })).toMatch(/nothing to change/);
  });

  it('refuses a value out of range, a fraction or not a number, by its name', () => {
    expect(lanePatchProblem({ bookConcurrency: 5 })).toBe(
      'book_concurrency must be a whole number 1 to 4, or null',
    );
    expect(lanePatchProblem({ bookConcurrency: 0 })).toMatch(/^book_concurrency/);
    expect(lanePatchProblem({ concurrency: 17 })).toMatch(/^concurrency must be .* 1 to 16/);
    expect(lanePatchProblem({ timeBudgetMinutes: 1.5 })).toMatch(/^time_budget_minutes/);
    expect(lanePatchProblem({ timeBudgetMinutes: 721 })).toMatch(/^time_budget_minutes/);
    expect(lanePatchProblem({ concurrency: Number.NaN })).toMatch(/^concurrency/);
    expect(lanePatchProblem({ concurrency: '2' as unknown as number })).toMatch(/^concurrency/);
  });
});
