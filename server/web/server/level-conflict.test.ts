import { describe, expect, it } from 'vitest';
import { ViewerLevelConflictError } from '@mantle/db/viewer';
import { levelConflictResponse } from './level-conflict';

describe('a viewer level conflict reaching the HTTP layer', () => {
  it('is a 403 with a reason code on /api, never the opaque 500', async () => {
    const res = levelConflictResponse(new ViewerLevelConflictError('client', 'public'), '/api/x');
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ error: 'forbidden', reason: 'level-conflict' });
  });

  it('is a plain 403 on a page', async () => {
    const res = levelConflictResponse(new ViewerLevelConflictError('public', 'client'), '/s/x');
    expect(res?.status).toBe(403);
  });

  it('leaves every other error alone', () => {
    expect(levelConflictResponse(new Error('boom'), '/api/x')).toBeNull();
    expect(levelConflictResponse('nope', '/api/x')).toBeNull();
  });
});
