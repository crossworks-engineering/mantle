import { expect, test } from '../lib/fixtures';

/**
 * /team-admin on the CLIENT origin (T5): the owner's team console renders
 * from the per-tab /api/team-admin/* routes with the owner credential —
 * bearer in the split project, session cookie same-origin. The old server
 * page is gone; this is the only surface.
 */
test.describe('team admin (owner, client origin)', () => {
  // Post-carve, the owner UI exists only on the CLIENT app — the same-origin
  // project covers the SERVER-origin surfaces; the split project runs this.
  test.skip(({ topology }) => topology === 'same-origin', 'owner UI lives on the client app');
  test('tabs render from the per-tab API routes', async ({ ownerPage }) => {
    await ownerPage.goto('/team-admin');
    // Members tab (default): the roster pane header.
    await expect(ownerPage.getByRole('heading', { name: 'Team members' })).toBeVisible({
      timeout: 30_000,
    });

    // Requests tab: empty-state or queue — either way the pane rendered.
    await ownerPage.getByRole('link', { name: /^Requests/ }).click();
    await expect(
      ownerPage.getByText(/No change requests or uploads yet|Uploads awaiting review/).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Settings tab: the three surface-wide switches.
    await ownerPage.getByRole('link', { name: 'Settings' }).click();
    await expect(ownerPage.getByRole('heading', { name: 'Read posture' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(ownerPage.getByRole('heading', { name: 'Hub app' })).toBeVisible();
  });
});
