/**
 * Hostile shapes in the zip formats read without a full parser (.pptx text,
 * OOXML and ODF pictures, Visio pages): the scanners are linear
 * (./xml-scan.ts), and the reads run in a worker thread (./isolate.ts), so
 * the server's event loop keeps turning while they do. The regular
 * expressions they replace took 9.1 s over 512 KB of unclosed `<a:t>`.
 */
import { describe, expect, it } from 'vitest';
import { hostilePptx } from './bombs.test-helper';
import { extractEmbeddedImages } from './embedded-images';
import { parseDocumentBytes } from './parse';
import { chartLine, paragraphsOf } from './pptx';
import { pageEntriesOf } from './vsdx';

/** The longest the event loop went without a turn while `fn` ran. */
async function lagWhile<T>(fn: () => Promise<T>): Promise<{ value: T; lagMs: number }> {
  let lagMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    lagMs = Math.max(lagMs, now - last - 10);
    last = now;
  }, 10);
  try {
    return { value: await fn(), lagMs };
  } finally {
    clearInterval(timer);
  }
}

/** How long `fn` took, in ms. */
function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

const KB512 = 512 * 1024;
const MAX_LAG_MS = 500;

/** Each hostile part, about 512 KB. */
const HOSTILE: Record<string, string> = {
  'unclosed <a:t>': '<a:p><a:t>'.repeat(KB512 / 10),
  'unclosed <c:v>': '<c:v>'.repeat(KB512 / 5),
  'tags with no >': '<a:p <a:t '.repeat(KB512 / 10),
  'a field never closed': `<a:fld type="slidenum">${'<a:t>x</a:t>'.repeat(KB512 / 12)}`,
  'unclosed picture tags': '<p:cNvPr descr="x" <a:blip r:embed="rId1" '.repeat(KB512 / 41),
  'a run of spaces': `<a:p><a:t>${' '.repeat(KB512)}x</a:t></a:p>`,
};

describe('the tag scanners are linear on hostile parts', () => {
  for (const [name, xml] of Object.entries(HOSTILE)) {
    it(`paragraphsOf and chartLine: ${name}`, () => {
      expect(timed(() => paragraphsOf(xml))).toBeLessThan(250);
      expect(timed(() => chartLine(xml))).toBeLessThan(250);
    });
  }

  it("Visio's pages part: 256 KB of <Page> left open", () => {
    const xml = `<Pages>${'<Page Name="p">'.repeat((256 * 1024) / 15)}`;
    expect(timed(() => pageEntriesOf(xml))).toBeLessThan(250);
  });
});

describe('hostile decks read off the main thread', () => {
  for (const [name, xml] of Object.entries(HOSTILE)) {
    it(`text: ${name}`, async () => {
      const deck = hostilePptx(xml);
      const { lagMs } = await lagWhile(() => parseDocumentBytes(deck, 'pptx').catch(() => ''));
      expect(lagMs).toBeLessThan(MAX_LAG_MS);
    }, 30_000);
  }

  it('pictures: unclosed picture tags', async () => {
    const deck = hostilePptx(HOSTILE['unclosed picture tags']!);
    const start = performance.now();
    const { value, lagMs } = await lagWhile(() => extractEmbeddedImages(deck, 'pptx'));
    expect(value.candidates).toBe(0);
    expect(lagMs).toBeLessThan(MAX_LAG_MS);
    expect(performance.now() - start).toBeLessThan(5_000);
  }, 30_000);
});
