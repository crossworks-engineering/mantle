import type { Page } from '@playwright/test';
import { expect, test } from '../lib/fixtures';
import { ARTIFACTS_DIR } from '../lib/env';

/**
 * The Excalidraw chrome follows the Mantle theme (draw-theme.css). Guards the
 * override wiring that is easiest to break silently: an import-order change or
 * an upstream variable rename just makes a surface fall back to stock styling,
 * which no other test would notice. Asserts the two highest-signal mappings —
 * island surfaces paint with the app's --popover token and the chrome runs in
 * the app's interface font — in BOTH themes, and drops a screenshot per theme
 * into e2e/.artifacts for human eyes.
 */

/** Computed color of a Mantle token, resolved by painting a probe element. */
async function probeColor(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const el = document.createElement('div');
    el.style.backgroundColor = `var(${t})`;
    document.body.appendChild(el);
    const c = getComputedStyle(el).backgroundColor;
    el.remove();
    return c;
  }, token);
}

test.describe('draw editor theming', () => {
  test.skip(({ topology }) => topology === 'same-origin', 'owner UI lives on the client app');

  test('editor chrome follows the Mantle theme in light and dark', async ({
    ownerApi,
    ownerPage,
  }) => {
    const created = await ownerApi.post('/api/draws', {
      data: { title: `E2E themed draw ${Date.now()}` },
    });
    const { draw } = (await created.json()) as { draw: { id: string } };

    try {
      for (const scheme of ['light', 'dark'] as const) {
        // The app's ThemeProvider defaults to system, so emulating the color
        // scheme before navigation drives the whole app (and the canvas's
        // theme prop) into that mode — same as a user's OS switch.
        await ownerPage.emulateMedia({ colorScheme: scheme });
        await ownerPage.goto(`/draw/${draw.id}`);

        // The editor chunk is lazy (~1.8 MB); wait for a real toolbar island.
        const island = ownerPage.locator('.excalidraw .Island').first();
        await expect(island).toBeVisible({ timeout: 30_000 });

        const editor = ownerPage.locator('.excalidraw').first();
        if (scheme === 'dark') {
          await expect(editor).toHaveClass(/theme--dark/);
        } else {
          await expect(editor).not.toHaveClass(/theme--dark/);
        }

        // Islands (toolbars, panels, menus) paint with the app's popover
        // token — the core surface mapping, and it must hold in dark too,
        // where the package's own theme--dark block would otherwise win.
        const popover = await probeColor(ownerPage, '--popover');
        await expect(island).toHaveCSS('background-color', popover);

        // The chrome runs in the app's interface font (body resolves the same
        // var(--font-sans)), not the bundled Assistant.
        const bodyFont = await ownerPage.evaluate(() => getComputedStyle(document.body).fontFamily);
        await expect(island).toHaveCSS('font-family', bodyFont);

        await ownerPage.screenshot({ path: `${ARTIFACTS_DIR}draw-theme-${scheme}.png` });

        // The main menu (a portaled dropdown) is the "menu backgrounds"
        // surface proper — it must take the popover token too.
        await ownerPage.getByTestId('main-menu-trigger').click();
        const menu = ownerPage.locator('.dropdown-menu-container').first();
        await expect(menu).toBeVisible();
        await expect(menu).toHaveCSS('background-color', popover);
        await ownerPage.screenshot({ path: `${ARTIFACTS_DIR}draw-theme-${scheme}-menu.png` });
        await ownerPage.keyboard.press('Escape');
      }
    } finally {
      await ownerApi.delete(`/api/draws/${draw.id}`);
    }
  });
});
