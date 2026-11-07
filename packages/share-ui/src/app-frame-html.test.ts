/**
 * The frame document is the only place that can witness a MODULE-LEVEL failure
 * — a link error or a module-scope throw happens before any component exists,
 * so the kit's ErrorBoundary cannot catch it. Without the reporter the parent
 * has no signal at all and can only time out with a causeless message, which is
 * exactly what a wrong `@host` import cost in the field.
 */
import { describe, expect, it } from 'vitest';
import {
  LOOK_LISTENER,
  appLibraryScripts,
  buildAppFrameCsp,
  buildAppFrameHtml,
  viewerScript,
} from './app-frame-html';

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
  const withNeat = () =>
    buildAppFrameHtml({
      bundleCode: 'console.log(1)',
      appCss: '',
      importMapJson: '{"imports":{}}',
      cls: 'dark',
      colorTheme: 'darkmatter',
      viewport: true,
      neatSpec: SPEC,
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
    // No surface attribute: an app's own text sits on the gradient, so every
    // frame paints the floored 'app' look (readDriftSurface's default).
    expect(html).not.toContain('data-drift-surface');
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

  it('makes --card translucent over a Neat ground, and ONLY then', () => {
    // The derived token sits on :root and the override on body — a custom
    // property may not reference itself on the same element. No spec ⇒ no
    // override, so apps on a plain brain stay pixel-identical.
    const html = withNeat();
    expect(html).toContain('--card-on-neat:color-mix(in oklab,var(--card) 70%,transparent)');
    expect(html).toContain('body{--card:var(--card-on-neat)}');
    expect(frame('console.log(1)')).not.toContain('--card-on-neat');
  });
});

describe('buildAppFrameHtml: host.me() (app identity)', () => {
  const withViewer = (viewer: Parameters<typeof viewerScript>[0]) =>
    buildAppFrameHtml({
      bundleCode: 'console.log(1)',
      appCss: '',
      importMapJson: '{"imports":{}}',
      cls: '',
      colorTheme: null,
      viewport: true,
      viewer,
    });

  it('bakes the viewer in BEFORE the app module, read-only', () => {
    const html = withViewer({ id: 'u_abc', name: 'Pat', kind: 'member' });
    const at = html.indexOf('__mantleHostMe');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf('<script type="module">'));
    expect(html).toContain('Object.freeze({"id":"u_abc","name":"Pat","kind":"member"})');
  });

  it('bakes nothing without a viewer (host.me() then rejects)', () => {
    expect(withViewer(null)).not.toContain('__mantleHostMe');
    expect(frame('x')).not.toContain('__mantleHostMe');
  });

  it('a display name cannot close the script tag', () => {
    const html = withViewer({
      id: 'u_x',
      name: '</script><script>alert(1)</script>\u2028',
      kind: 'client',
    });
    const script = viewerScript({ id: 'u_x', name: '</script>', kind: 'client' });
    expect(script).not.toContain('</script><');
    expect(script).toContain('\\u003c/script>');
    expect(html.match(/<\/script>/g)?.length).toBe(
      withViewer({ id: 'u', name: 'n', kind: 'client' }).match(/<\/script>/g)?.length,
    );
  });

  it('carries only id, name and kind, whatever else the object holds', () => {
    const script = viewerScript({
      id: 'u_x',
      name: 'Pat',
      kind: 'member',
      email: 'pat@example.invalid',
    } as never);
    expect(script).not.toContain('email');
    expect(script).not.toContain('example.invalid');
  });

  it('an open link bakes the anonymous viewer', () => {
    expect(viewerScript({ id: null, name: null, kind: 'public' })).toContain(
      '{"id":null,"name":null,"kind":"public"}',
    );
  });
});

describe('buildAppFrameCsp: the library files an app may load', () => {
  const O = 'https://box.example';
  const map = {
    react: '/app-runtime/react-AB12.js',
    echarts: '/canvas-runtime/echarts-CD34.js',
    d3: '/canvas-runtime/d3-EF56.js',
    again: '/canvas-runtime/d3-EF56.js',
    bad: '/canvas-runtime/x.js; script-src *',
    query: '/canvas-runtime/y.js?z',
  };

  it('names each library file of the import map, once, and never the folder', () => {
    expect(appLibraryScripts(map)).toEqual([
      '/canvas-runtime/d3-EF56.js',
      '/canvas-runtime/echarts-CD34.js',
    ]);
    const csp = buildAppFrameCsp(O, appLibraryScripts(map));
    const scripts = csp.match(/script-src ([^;]+);/)![1]!.split(' ');
    expect(scripts).toContain(`${O}/canvas-runtime/echarts-CD34.js`);
    expect(scripts).toContain(`${O}/canvas-runtime/d3-EF56.js`);
    expect(scripts).not.toContain(`${O}/canvas-runtime/`);
  });

  it('takes no source a list could smuggle in', () => {
    const csp = buildAppFrameCsp(O, [
      '/canvas-runtime/x.js; script-src *',
      'https://evil.invalid/a.js',
    ]);
    expect(csp).not.toContain('evil.invalid');
    expect(csp.match(/script-src/g)).toHaveLength(1);
  });

  it('with no list, no library file at all', () => {
    expect(buildAppFrameCsp(O)).not.toContain('/canvas-runtime/');
  });

  it('compiles WebAssembly but never evals script, and stays offline', () => {
    const csp = buildAppFrameCsp(O);
    const scripts = csp.match(/script-src ([^;]+);/)![1]!.split(' ');
    expect(scripts).toContain("'wasm-unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(csp).toContain("connect-src 'none'");
  });
});

describe('buildAppFrameHtml: the frame draws itself for ui_look', () => {
  /** The listener run against a stand-in window, its dynamic import stood in. */
  function listener(draw: (scale: number) => Promise<string>) {
    const parent = {
      sent: [] as unknown[],
      postMessage(m: unknown) {
        this.sent.push(m);
      },
    };
    let onMessage: ((e: { source: unknown; data: unknown }) => void) | null = null;
    const win = {
      parent,
      addEventListener: (_t: string, fn: typeof onMessage) => (onMessage = fn),
    };
    const loaded: string[] = [];
    const code = LOOK_LISTENER.replace("import('/share-runtime/frame-look.js')", '__imp()');
    expect(code).not.toBe(LOOK_LISTENER);
    new Function('window', '__imp', code)(win, () => {
      loaded.push('/share-runtime/frame-look.js');
      return Promise.resolve({ drawFrame: draw });
    });
    const send = async (source: unknown, data: unknown) => {
      onMessage!({ source, data });
      await new Promise((r) => setTimeout(r, 0));
    };
    return { parent, loaded, send };
  }

  it('is in every frame document, and the CSP lets it load its drawer', () => {
    expect(frame('x')).toContain(LOOK_LISTENER);
    expect(buildAppFrameCsp('https://b.example')).toContain('https://b.example/share-runtime/');
  });

  it('answers its parent once, with the picture at the asked scale', async () => {
    const scales: number[] = [];
    const l = listener(async (s) => {
      scales.push(s);
      return 'data:image/png;base64,AAAA';
    });
    await l.send(l.parent, { v: 1, kind: 'look', id: 'q1', scale: 1.5 });
    expect(scales).toEqual([1.5]);
    expect(l.parent.sent).toEqual([
      { ok: true, dataUrl: 'data:image/png;base64,AAAA', v: 1, kind: 'look.res', id: 'q1' },
    ]);
  });

  it('a failed draw says why', async () => {
    const l = listener(async () => {
      throw new Error('no canvas');
    });
    await l.send(l.parent, { v: 1, kind: 'look', id: 'q2', scale: 1 });
    expect(l.parent.sent).toEqual([
      { ok: false, error: 'no canvas', v: 1, kind: 'look.res', id: 'q2' },
    ]);
  });

  it('ignores anyone but its parent, and any other message: nothing is loaded', async () => {
    const l = listener(async () => 'data:,');
    await l.send({}, { v: 1, kind: 'look', id: 'q3', scale: 1 });
    await l.send(l.parent, { v: 1, kind: 'theme', cls: 'dark' });
    await l.send(l.parent, { v: 1, kind: 'look', scale: 1 });
    expect(l.loaded).toEqual([]);
    expect(l.parent.sent).toEqual([]);
  });
});
