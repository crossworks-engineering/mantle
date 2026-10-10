import { describe, expect, it } from 'vitest';
import { SCOPE_AREAS } from '@mantle/db/viewer';
import { WORKSPACE_AREAS } from '@mantle/client-types/dto/workspaces';

/** scopeHasArea (packages/db) and the workspace screens (W5a) name the same
 *  areas: one list in two packages that cannot import each other. */
describe('scope areas', () => {
  it('equal the workspace areas', () => {
    expect([...SCOPE_AREAS].sort()).toEqual([...WORKSPACE_AREAS].sort());
  });
});
