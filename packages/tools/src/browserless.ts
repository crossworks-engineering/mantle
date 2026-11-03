/**
 * The one way a render names its launch options to the browser sidecar
 * (browserless): the canvas render (canvas-render/sidecar.ts) and the
 * drawing PNG (server/web/lib/render-draw-png.ts).
 *
 * browserless starts one browser per connection, with the launch options it
 * reads from the URL. It drives that browser with its own puppeteer, and
 * that puppeteer gives every new page the launch's `defaultViewport`
 * (800x600 when none is named) at a moment of its own. That races the
 * render's own setViewport: on a busy box it often lands last, and the page
 * lays out at 800x600 at a scale of 1, while the render's screenshot still
 * has the asked size. So a render that sets a viewport names the same one
 * here, and both set the same size in either order. browserless refuses
 * `defaultViewport: null`, so the size itself is the value.
 */

/** The size a render lays out at, and its pixel scale. */
export type RenderViewport = { width: number; height: number; deviceScaleFactor: number };

export type BrowserlessLaunch = {
  /** Extra browser flags; left out, browserless starts with its own. */
  args?: readonly string[];
  defaultViewport: RenderViewport;
};

/** A bare DevTools endpoint (a local Chrome): no browserless in front, so no
 *  launch options; that browser was started by whoever runs it. */
export function isBareDevtoolsEndpoint(endpoint: string): boolean {
  return endpoint.includes('/devtools/browser/');
}

/** The sidecar URL with the launch options; a bare DevTools endpoint is
 *  left as it is. */
export function browserlessEndpoint(endpoint: string, launch: BrowserlessLaunch): string {
  if (isBareDevtoolsEndpoint(endpoint)) return endpoint;
  const url = new URL(endpoint);
  url.searchParams.set(
    'launch',
    JSON.stringify({
      ...(launch.args ? { args: launch.args } : {}),
      defaultViewport: launch.defaultViewport,
    }),
  );
  return url.toString();
}
