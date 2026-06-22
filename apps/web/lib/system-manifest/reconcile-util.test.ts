import { describe, expect, it } from 'vitest';
import { missingPersonaGroups } from './reconcile-util';

describe('missingPersonaGroups', () => {
  it('returns the manifest groups the agent does not yet hold', () => {
    expect(missingPersonaGroups(['location'], ['location', 'profile'])).toEqual(['profile']);
  });

  it('is empty when the agent already holds every manifest group', () => {
    expect(missingPersonaGroups(['a', 'b', 'c'], ['a', 'b'])).toEqual([]);
  });

  it('only ADDS — never proposes removing an operator-held group not in the manifest', () => {
    // The operator added 'custom-group' and removed default 'email'.
    const result = missingPersonaGroups(['location', 'custom-group'], ['location', 'email', 'profile']);
    expect(result).toEqual(['email', 'profile']); // re-adds the removed default + the new one
    expect(result).not.toContain('custom-group'); // never touches operator extras
  });

  it('treats null/undefined current grants as empty', () => {
    expect(missingPersonaGroups(null, ['location'])).toEqual(['location']);
    expect(missingPersonaGroups(undefined, ['location'])).toEqual(['location']);
  });
});
