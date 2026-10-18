import { describe, expect, it } from 'vitest';
import { SCOPE_AREAS } from '@mantle/db/viewer';
import { WORKSPACE_AREAS } from '@mantle/client-types/dto/workspaces';

/** scopeHasArea (packages/db) and the workspace screens (W5a) name the same
 *  areas: since A10 #13 one list, SCOPE_AREAS is WORKSPACE_AREAS. The limits
 *  rule (false or "false" switches an area off) has one source since S8a,
 *  mantle_area_rule: packages/db/src/login-facts.db.test.ts holds it. */
describe('scope areas', () => {
  it('equal the workspace areas, in order', () => {
    expect([...SCOPE_AREAS]).toEqual([...WORKSPACE_AREAS]);
  });
});
