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
    // The reader is a public surface: full colour, its text kept off the
    // gradient by shareShell's sheet.
    expect(html).toContain('data-drift-surface="public"');
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
});

describe('shareShell — the ground under the gradient', () => {
  it('paints bg-background by default', () => {
    expect(shareShell('<p>x</p>')).toContain('bg-background');
  });

  it('goes transparent round an opaque sheet when a gradient is active', () => {
    const html = shareShell('<p>x</p>', { neat: true });
    // The shell's own ground is gone, so the gradient shows round the sheet.
    expect(html).toMatch(
      /^<div class="flex h-dvh flex-col overflow-y-auto scrollbar-thin text-foreground">/,
    );
    // Every word of the content sits on the opaque sheet.
    expect(html).toMatch(
      /<div data-share-sheet class="[^"]*\bbg-background\b[^"]*"><p>x<\/p><\/div>/,
    );
    // overflow-clip, never hidden: the sheet must not become a scroll
    // container, or the contact strip inside it stops being sticky.
    expect(html).toContain('overflow-clip');
    expect(html).not.toContain('overflow-hidden');
  });

  it('keeps the public rule: no text sits directly on the full-colour gradient', () => {
    // The public Drift surface drops the legibility floor (spec.ts
    // DriftSurface), so every text node outside the sheet must have an
    // opaque backing of its own. Strip the sheet's contents and check what
    // is left: each remaining text run sits in a bg-background element.
    const html = shareShell('<p>x</p>', { neat: true }).replace(
      /(<div data-share-sheet[^>]*>)[\s\S]*?(<\/div><\/main>)/,
      '$1$2',
    );
    const texts = [...html.matchAll(/>([^<>]*\S[^<>]*)</g)].map((m) => m[1]!.trim());
    expect(texts).toEqual(['Shared via', 'mantle']);
    expect(html).toMatch(/<span class="[^"]*\bbg-background\b[^"]*">Shared via <span/);
  });
});
