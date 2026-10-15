import { describe, expect, it } from 'vitest';
import { SCOPE_AREAS } from '@mantle/db/viewer';
import { WORKSPACE_AREAS } from '@mantle/client-types/dto/workspaces';
import { areasFromLimits } from './workspaces';

/** scopeHasArea (packages/db) and the workspace screens (W5a) name the same
 *  areas: since A10 #13 one list, SCOPE_AREAS is WORKSPACE_AREAS. */
describe('scope areas', () => {
  it('equal the workspace areas, in order', () => {
    expect([...SCOPE_AREAS]).toEqual([...WORKSPACE_AREAS]);
  });

  it('switch an area off with false or "false", as SQL does (audit L5)', () => {
    expect(areasFromLimits({})).toEqual([...WORKSPACE_AREAS]);
    expect(areasFromLimits({ areas: { keys: true } })).toEqual([...WORKSPACE_AREAS]);
    expect(areasFromLimits({ areas: { keys: false } })).not.toContain('keys');
    expect(areasFromLimits({ areas: { keys: 'false', users: false } })).toEqual(
      WORKSPACE_AREAS.filter((a) => a !== 'keys' && a !== 'users'),
    );
  });
});
