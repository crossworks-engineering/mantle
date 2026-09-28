import { describe, expect, it } from 'vitest';
import { describeError } from './describe-error';

describe('describeError', () => {
  it('reports the Postgres reason from under a Drizzle wrapper, not the query', () => {
    const pg = Object.assign(
      new Error('duplicate key value violates unique constraint "nodes_owner_slug_uq"'),
      { code: '23505', constraint_name: 'nodes_owner_slug_uq' },
    );
    const wrapped = new Error(
      `Failed query: insert into "nodes" (...) values (...)\nparams: ${'sermon text '.repeat(500)}`,
      { cause: pg },
    );
    const line = describeError(wrapped);
    expect(line).toBe(
      'duplicate key value violates unique constraint "nodes_owner_slug_uq" (23505, nodes_owner_slug_uq)',
    );
    expect(line).not.toContain('\n');
  });

  it('caps a plain error to one short line', () => {
    const line = describeError(new Error(`bad\n${'x'.repeat(1000)}`));
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThanOrEqual(301);
  });

  it('handles non-Error throws', () => {
    expect(describeError('nope')).toBe('nope');
    expect(describeError(undefined)).toBe('undefined');
  });
});
