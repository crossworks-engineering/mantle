import { describe, expect, it } from 'vitest';
import { SHARE_MODE_STORAGE_KEY } from '@mantle/share-ui/share-mode';
import { htmlPage, shareShell } from './template';

/**
 * The /s reader-chrome contract on htmlPage/shareShell — mode stamping, the
 * pre-paint script, the Neat host div, and which bundles load. These are
 * string-built branches with no type-level safety net, and the pre-paint
 * script + share-page.js runtime must agree on the localStorage key and the
 * `data-share-mode-default` attribute; this file is what holds them together.
 */

const SPEC = '{"v":1,"seed":42,"tone":"auto","speed":2}';

describe('htmlPage — share reader chrome', () => {
  it('renders none of the share chrome when share meta is absent (print, stubs)', () => {
    const html = htmlPage({ title: 'T' }, '<p>body</p>');
    expect(html).toContain('<html lang="en" class="h-full"');
    expect(html).not.toContain('dark');
    expect(html).not.toContain('data-share-mode-default');
    expect(html).not.toContain('share-page.js');
    expect(html).not.toContain('data-neat-spec');
  });

  it('stamps the owner dark default server-side and carries it as an attribute', () => {
    const html = htmlPage(
      { title: 'T', share: { defaultMode: 'dark', readerChrome: true } },
      '<p>body</p>',
    );
    expect(html).toContain('class="h-full dark"');
    expect(html).toContain('data-share-mode-default="dark"');
  });

  it('leaves light/system un-stamped — the pre-paint script resolves those', () => {
    for (const defaultMode of ['light', 'system'] as const) {
      const html = htmlPage({ title: 'T', share: { defaultMode, readerChrome: true } }, '<p>b</p>');
      expect(html).toContain('class="h-full"');
      expect(html).toContain(`data-share-mode-default="${defaultMode}"`);
    }
  });

  it('inlines the pre-paint script bound to the shared storage key', () => {
    const html = htmlPage(
      { title: 'T', share: { defaultMode: 'system', readerChrome: true } },
      '<p>body</p>',
    );
    // The runtime writes this key, the inline script reads it: one constant.
    expect(html).toContain(`localStorage.getItem('${SHARE_MODE_STORAGE_KEY}')`);
    expect(html).toContain('prefers-color-scheme: dark');
  });

  it('loads share-page.js and renders the Neat host with reader chrome + a saved spec', () => {
    const html = htmlPage(
      { title: 'T', share: { defaultMode: 'light', neat: SPEC, readerChrome: true } },
      '<p>body</p>',
    );
    expect(html).toContain('src="/share-runtime/share-page.js"');
    // The spec is attribute-escaped, exactly once, ahead of the body.
    expect(html).toContain('data-neat-spec="{&quot;v&quot;:1');
    expect(html).toContain('pointer-events-none fixed inset-0 -z-10');
  });

  it('keeps the toggle runtime without a host div when no background is saved', () => {
    const html = htmlPage(
      { title: 'T', share: { defaultMode: 'light', neat: null, readerChrome: true } },
      '<p>body</p>',
    );
    expect(html).toContain('src="/share-runtime/share-page.js"');
    expect(html).not.toContain('data-neat-spec');
  });

  it('mode-stamps only for the app kind (readerChrome false): no toggle, no backdrop', () => {
    const html = htmlPage(
      { title: 'T', share: { defaultMode: 'dark', neat: SPEC, readerChrome: false } },
      '<p>body</p>',
    );
    expect(html).toContain('class="h-full dark"');
    expect(html).not.toContain('share-page.js');
    expect(html).not.toContain('data-neat-spec');
  });

  it('carries the licence key on the host div only when set', () => {
    const on = htmlPage(
      {
        title: 'T',
        share: { defaultMode: 'light', neat: SPEC, neatLicense: 'k-1', readerChrome: true },
      },
      '<p>b</p>',
    );
    expect(on).toContain('data-neat-license="k-1"');
    const off = htmlPage(
      { title: 'T', share: { defaultMode: 'light', neat: SPEC, readerChrome: true } },
      '<p>b</p>',
    );
    expect(off).not.toContain('data-neat-license');
  });
});

describe('shareShell — the ground under the gradient', () => {
  it('paints bg-background by default', () => {
    expect(shareShell('<p>x</p>')).toContain('bg-background');
  });

  it('goes transparent when a gradient is active — body remains the fallback fill', () => {
    expect(shareShell('<p>x</p>', { neat: true })).not.toContain('bg-background');
  });
});
