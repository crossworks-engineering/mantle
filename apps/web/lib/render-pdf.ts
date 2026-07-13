import 'server-only';
import puppeteer, { type Browser } from 'puppeteer';

/**
 * Headless-Chromium PDF rendering for Pages. Rather than re-implement the page
 * schema a fourth time (editor / markdownToDoc / renderPageDoc / renderDocx),
 * we point a real browser at the app's OWN owner-authed `/print/pages/<id>`
 * route — forwarding the caller's session cookie — and print-to-PDF. The PDF
 * therefore reuses the live page CSS (callouts, code highlight, KaTeX, images,
 * asides) and looks exactly like the on-screen page.
 *
 * One browser is shared across requests (a launch is ~hundreds of ms and tens
 * of MB); each request opens its own tab. In prod, PUPPETEER_EXECUTABLE_PATH
 * points at the system Chromium the Docker image installs; in dev, puppeteer
 * falls back to its cached download.
 */
let browserP: Promise<Browser> | null = null;

function launch(): Promise<Browser> {
  return puppeteer.launch({
    headless: true,
    // Prod: system Chromium (Docker installs it). Dev: undefined → puppeteer's
    // own cached Chromium.
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    // --no-sandbox: we run as root in the container; the input is our own
    // server-rendered HTML, not untrusted web content. --disable-dev-shm-usage:
    // containers cap /dev/shm at 64 MB and Chromium can exceed it mid-render.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

async function getBrowser(): Promise<Browser> {
  if (browserP) {
    try {
      const b = await browserP;
      if (b.connected) return b;
    } catch {
      // launch failed earlier — fall through and relaunch.
    }
  }
  browserP = launch();
  return browserP;
}

/**
 * Render an app URL (an owner-authed `/print/...` surface) to a PDF Buffer.
 * `cookie` is the caller's raw `Cookie` header, forwarded so the print route —
 * and every image subresource it loads from the authed asset route —
 * authenticates as the owner.
 */
export async function renderUrlToPdf(url: string, cookie: string): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    if (cookie) await page.setExtraHTTPHeaders({ cookie });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
    const bytes = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
    });
    return Buffer.from(bytes);
  } finally {
    await page.close().catch(() => {});
  }
}
