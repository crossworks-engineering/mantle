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
