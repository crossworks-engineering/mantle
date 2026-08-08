import { expect, test } from '../lib/fixtures';
import { ARTIFACTS_DIR } from '../lib/env';

/**
 * The pages/draw editor header is ONE compact row: icon + title left, tags
 * right, no band box. It used to be two stacked rows in a bordered strip that
 * ate ~15% of the viewport; this pins the fix with a hard height budget and a
 * same-row check, in both editors, so a future padding/wrap regression fails
 * loudly. Also covers the draw icon end to end (PATCH → header trigger →
 * list row), since draws only just learned icons.
 */

/** Generous ceiling for the whole header row — the old design measured ~110px. */
const HEADER_MAX_PX = 64;

test.describe('editor header layout', () => {
  test.skip(({ topology }) => topology === 'same-origin', 'owner UI lives on the client app');

  test('pages: one compact row, title left / tags right', async ({ ownerApi, ownerPage }) => {
    const created = await ownerApi.post('/api/pages', {
      data: { title: `E2E header page ${Date.now()}`, tags: ['alpha', 'beta'] },
    });
    const { page: row } = (await created.json()) as { page: { id: string } };

    try {
      await ownerPage.goto(`/pages/${row.id}`);
      const title = ownerPage.locator('input[aria-label="Page title"]');
      await expect(title).toBeVisible();

      const header = ownerPage.locator('header:has(input[aria-label="Page title"])');
      const box = await header.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeLessThan(HEADER_MAX_PX);

      // Title and tags share the row (two columns, not stacked).
      const titleBox = await title.boundingBox();
      const tagsBox = await ownerPage.getByPlaceholder('Add tags…').boundingBox();
      const centerDelta = Math.abs(
        titleBox!.y + titleBox!.height / 2 - (tagsBox!.y + tagsBox!.height / 2),
      );
      expect(centerDelta).toBeLessThan(8);
      // Tags sit to the RIGHT of the title, start-aligned layout.
      expect(tagsBox!.x).toBeGreaterThan(titleBox!.x);

      await ownerPage.screenshot({ path: `${ARTIFACTS_DIR}editor-header-page.png` });
    } finally {
      await ownerApi.delete(`/api/pages/${row.id}`);
    }
  });

  test('draw: same compact row, and the icon persists to header + list', async ({
    ownerApi,
    ownerPage,
  }) => {
    const title = `E2E header draw ${Date.now()}`;
    const created = await ownerApi.post('/api/draws', { data: { title, tags: ['alpha'] } });
    const { draw } = (await created.json()) as { draw: { id: string } };

    try {
      // The icon saves like the rest of the metadata and round-trips.
      const patched = await ownerApi.patch(`/api/draws/${draw.id}`, { data: { icon: '🎨' } });
      expect(patched.ok()).toBeTruthy();
      expect(((await patched.json()) as { draw: { icon: string | null } }).draw.icon).toBe('🎨');

      await ownerPage.goto(`/draw/${draw.id}`);
      const titleInput = ownerPage.locator('input[aria-label="Drawing title"]');
      await expect(titleInput).toBeVisible();

      const header = ownerPage.locator('header:has(input[aria-label="Drawing title"])');
      const box = await header.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeLessThan(HEADER_MAX_PX);

      const titleBox = await titleInput.boundingBox();
      const tagsBox = await ownerPage.getByPlaceholder('Add tags…').boundingBox();
      expect(
        Math.abs(titleBox!.y + titleBox!.height / 2 - (tagsBox!.y + tagsBox!.height / 2)),
      ).toBeLessThan(8);

      // The picker trigger shows the chosen emoji…
      await expect(ownerPage.getByRole('button', { name: 'Change drawing icon' })).toHaveText('🎨');
      await ownerPage.screenshot({ path: `${ARTIFACTS_DIR}editor-header-draw.png` });

      // …and so does the list row (rowOf carries data.icon).
      await ownerPage.goto(`/draw?q=${encodeURIComponent(title)}`);
      await expect(ownerPage.locator(`[data-mark-label="${title}"]`).getByText('🎨')).toBeVisible();
    } finally {
      await ownerApi.delete(`/api/draws/${draw.id}`);
    }
  });
});
