/**
 * A mini app frame draws itself for `ui_look` (docs/agent-ui.md, "Look").
 * The host page cannot read inside a sandboxed app frame (opaque origin), so
 * when the agent looks at a window that shows an app, the host asks the
 * frame (`{ kind: 'look' }` over the app bridge) and the frame document's
 * small listener (app-frame-html.ts) imports this file and answers with the
 * picture.
 *
 * Loaded by the host's frame document, never bundled into an app: it works
 * for every app already built, and it is fetched only when the agent looks.
 * Bundled by scripts/build-share-runtime.ts into public/share-runtime/
 * frame-look.js (modern-screenshot inside, MIT).
 *
 * The frame's CSP has `connect-src 'none'`, so nothing can be fetched to
 * embed: fonts are left out (`font: false`, the text draws in a fallback
 * font) and an image the redraw would fetch comes out blank. The visible
 * viewport is drawn, at the host's scale.
 *
 * modern-screenshot reads each tag's default style from a helper frame it
 * adds to the page; inside the sandbox that frame is another opaque origin
 * and reading it throws. So it gets a stand-in with no window: it then
 * copies every computed style, a larger drawing but the same picture.
 */
import { createContext, destroyContext, domToCanvas } from 'modern-screenshot';

/** The frame's visible viewport as a PNG data URL, at `scale` (clamped). */
export async function drawFrame(scale: number): Promise<string> {
  const s = Number.isFinite(scale) ? Math.min(4, Math.max(0.25, scale)) : 1;
  const context = await createContext(document.documentElement, {
    scale: s,
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    font: false,
    timeout: 1500,
  });
  context.sandbox = { contentWindow: null, remove() {} } as unknown as HTMLIFrameElement;
  try {
    const canvas = await domToCanvas(context);
    return canvas.toDataURL('image/png');
  } finally {
    destroyContext(context);
  }
}
