/**
 * A team app's Table write ceilings (task 2178377a, its audit): a
 * batch that would take the draft past its row ceiling, or a draft file
 * already past its byte ceiling, is refused before anything is staged
 * (applyTableOps asks appDraftCeilingRefusal for an app's write). The row
 * path through the broker is proven on Postgres in
 * server/web/server/team-app-table-writes.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { APP_DRAFT_MAX_BYTES, APP_DRAFT_MAX_ROWS, appDraftCeilingRefusal } from './draft';

describe('appDraftCeilingRefusal', () => {
  it('lets a batch up to the row ceiling through', () => {
    expect(appDraftCeilingRefusal(APP_DRAFT_MAX_ROWS - 10, 10, 1024)).toBeNull();
    expect(appDraftCeilingRefusal(0, 1, 0)).toBeNull();
  });

  it('refuses a batch past the row ceiling, saying nothing was written', () => {
    const why = appDraftCeilingRefusal(APP_DRAFT_MAX_ROWS - 10, 11, 1024);
    expect(why).toContain("row ceiling of a team app's writes");
    expect(why).toContain('Nothing was written');
  });

  it('takes the lower box ceiling when one is passed', () => {
    expect(appDraftCeilingRefusal(3, 1, 0, 3)).toContain('3-row ceiling');
    expect(appDraftCeilingRefusal(2, 1, 0, 3)).toBeNull();
  });

  it('refuses a draft file already past the byte ceiling', () => {
    expect(appDraftCeilingRefusal(1, 1, APP_DRAFT_MAX_BYTES + 1)).toContain('20 MB ceiling');
    expect(appDraftCeilingRefusal(1, 1, APP_DRAFT_MAX_BYTES)).toBeNull();
  });
});
