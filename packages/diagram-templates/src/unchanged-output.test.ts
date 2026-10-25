/**
 * The output pin. Every drawing that existed before tees and branches came
 * in (2026-10-25) draws byte for byte as it did: the same SVG, the same
 * warnings, the same themed SVG. Present canvases, `diagram_render` and
 * `present_export` rebuild from stored data, so a moved pixel here would
 * quietly change every saved diagram. A hash that moves is a regression,
 * not a test to update: find what changed for data without tees.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { estimateMeasurer, render } from './index.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24);

// [file, template, svg, warnings, themed svg], measured with the estimate.
const PINS: [string, string, string, string, string][] = [
  [
    'samples/flow-architecture.json',
    'flow',
    '180b05f25d4bb9df74c6eabe',
    '5ad017f19c391f7f158a27ab',
    '13372b904899be608bde4385',
  ],
  [
    'samples/flow-ingest.json',
    'flow',
    'a51bbb4880bc043a31fa2fa3',
    '4fda77d7e49ce88a9782fa19',
    'b926abf8cff7e54d4f0228ce',
  ],
  [
    'samples/flow-review-loop.json',
    'flow',
    'fa828591fd793a9cf6b55e20',
    '4f53cda18c2baa0c0354bb5f',
    'dc7147a3eac58d10690e5758',
  ],
  [
    'samples/pid-column-site-profile.json',
    'pid',
    '224a7a96126f73d04a77ce78',
    '5c1624b6bc53ba5266a9371c',
    'd3a4f6f98e84c39a1127a1c5',
  ],
  [
    'samples/pid-feed-drum.json',
    'pid',
    'ae548fb8b2d7dfcae5203d76',
    '4f53cda18c2baa0c0354bb5f',
    '1d2318bb806817ca202c2c75',
  ],
  [
    'test/pid-all-parts.json',
    'pid',
    'c357d4d3a7ada54b30768bbb',
    'b08ec3cd93805f20f344c6f0',
    'a297776fa3285d3fe262a692',
  ],
];

describe('drawings without tees draw as before', () => {
  it.each(PINS)('%s', (file, template, svg, warnings, themed) => {
    const data = JSON.parse(readFileSync(path.join(ROOT, file), 'utf8')) as unknown;
    const plain = render(template, data, estimateMeasurer);
    const tokens = render(template, data, estimateMeasurer, { theme: 'tokens' });
    expect(plain.ok && tokens.ok).toBe(true);
    if (!plain.ok || !tokens.ok) return;
    expect(hash(plain.svg)).toBe(svg);
    expect(hash(JSON.stringify(plain.warnings))).toBe(warnings);
    expect(hash(tokens.svg)).toBe(themed);
  });
});
