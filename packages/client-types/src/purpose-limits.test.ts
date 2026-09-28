import { describe, expect, it } from 'vitest';
import { PURPOSE_MAX_CHARS, purposeTooLongError } from './purpose-limits';

describe('PURPOSE_MAX_CHARS', () => {
  it('is 600, the ceiling the identity block renders', () => {
    expect(PURPOSE_MAX_CHARS).toBe(600);
  });
});

describe('purposeTooLongError', () => {
  it('names the length, the limit, and where the personality lives', () => {
    const msg = purposeTooLongError(3888);
    expect(msg).toContain('3,888');
    expect(msg).toContain('600');
    expect(msg).toContain('Agent Studio');
  });
});
