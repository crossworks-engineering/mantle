/** The tools' answer to a database refusal (arch A3a fix round 2, L5). */
import { describe, expect, it } from 'vitest';
import { DATABASE_ERROR_PUBLIC } from '@mantle/std';
import { toolDatabaseError } from './tool-input';

const pg = (message: string, detail?: string) =>
  Object.assign(new Error(message), { code: '42501', ...(detail ? { detail } : {}) });

describe('toolDatabaseError', () => {
  it('no_read is not found; a hidden-rows refusal says so plainly; the rest is masked', () => {
    expect(toolDatabaseError(pg('not allowed to change this item', 'no_read'))).toBe('not found');
    expect(toolDatabaseError(pg('This folder holds items you cannot move.', 'hidden_rows'))).toBe(
      'This folder holds items you cannot move.',
    );
    expect(toolDatabaseError(pg('not allowed to change this item', 'no_edit'))).toBe(
      DATABASE_ERROR_PUBLIC,
    );
    expect(toolDatabaseError(Object.assign(new Error('x'), { code: '23505' }))).toBe(
      DATABASE_ERROR_PUBLIC,
    );
  });
});
