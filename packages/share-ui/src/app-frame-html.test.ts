/**
 * The frame document is the only place that can witness a MODULE-LEVEL failure
 * — a link error or a module-scope throw happens before any component exists,
 * so the kit's ErrorBoundary cannot catch it. Without the reporter the parent
 * has no signal at all and can only time out with a causeless message, which is
 * exactly what a wrong `@host` import cost in the field.
 */
import { describe, expect, it } from 'vitest';
import { buildAppFrameHtml } from './app-frame-html';

const frame = (bundleCode: string) =>
  buildAppFrameHtml({
    bundleCode,
    appCss: '',
    importMapJson: '{"imports":{}}',
    cls: '',
    colorTheme: null,
    viewport: true,
  });

describe('buildAppFrameHtml — error reporting', () => {
  it('installs the reporter BEFORE the app module, or it cannot catch boot', () => {
    const html = frame('console.log(1)');
    const reporter = html.indexOf("addEventListener('error'");
    const appModule = html.indexOf('<script type="module">');
    expect(reporter).toBeGreaterThan(-1);
    expect(appModule).toBeGreaterThan(-1);
    expect(reporter).toBeLessThan(appModule);
  });

  it('posts the bridge-shaped error message the parent already understands', () => {
    const html = frame('console.log(1)');
    expect(html).toContain("kind:'error'");
    expect(html).toContain('v:1');
    expect(html).toContain('window.parent.postMessage');
  });

  it('listens in the capture phase — a module script error does not bubble', () => {
    expect(frame('x')).toMatch(/addEventListener\('error'[\s\S]*?\}, true\)/);
  });

  it('also covers an unhandled rejection at module scope', () => {
    expect(frame('x')).toContain("addEventListener('unhandledrejection'");
  });

  it('still emits the app bundle and the import map', () => {
    const html = frame('const marker = 42;');
    expect(html).toContain('const marker = 42;');
    expect(html).toContain('<script type="importmap">{"imports":{}}</script>');
  });
});

describe('buildAppFrameHtml — the Neat backdrop', () => {
  const SPEC = '{"v":1,"seed":42,"tone":"auto","speed":2}';
  const withNeat = (neatLicense?: string | null) =>
    buildAppFrameHtml({
      bundleCode: 'console.log(1)',
      appCss: '',
      importMapJson: '{"imports":{}}',
      cls: 'dark',
      colorTheme: 'darkmatter',
      viewport: true,
      neatSpec: SPEC,
      neatLicense,
    });

  it('renders no host div and no runtime script without a spec', () => {
    const html = frame('console.log(1)');
    expect(html).not.toContain('data-neat-spec');
    expect(html).not.toContain('share-page.js');
  });

  it('renders the host div at z-index:-1 plus the runtime script with a spec', () => {
    const html = withNeat();
    expect(html).toContain('data-neat-spec="{&quot;v&quot;:1');
    expect(html).toContain('z-index:-1');
    expect(html).toContain('src="/share-runtime/share-page.js"');
    // No reader attribute — the runtime must never mount its toggle in a frame.
    expect(html).not.toContain('data-share-mode-default');
  });

  it('keeps html transparent so the body ground propagates BENEATH the canvas', () => {
    const html = withNeat();
    // Body ground + transparent html is the /s arrangement: the background
    // propagates to the canvas layer, under the z-index:-1 backdrop. An html
    // background (or a bg-background class painting body as an element)
    // would sit above the backdrop and hide it.
    expect(html).toContain('body{background:var(--background)}');
    expect(html).not.toContain('html{background');
    expect(html).not.toContain('<body class="bg-background');
  });

  it('carries the licence only when set', () => {
    expect(withNeat('k-1')).toContain('data-neat-license="k-1"');
    expect(withNeat()).not.toContain('data-neat-license');
  });
});
