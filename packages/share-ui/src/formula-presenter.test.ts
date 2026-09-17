import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { checkDimensions } from '@mantle/content-core/formula-dimensions';
import { checkLookupCoverage, parseFormulaSpec } from '@mantle/content-core/formula-spec';
import { FormulaPresenter } from './formula-presenter';

/**
 * The public page is server-rendered on purpose: a shared engineering
 * calculation that appears without its caveats is worse than one that does not
 * appear at all. These tests hold the static HTML — no island, no JavaScript —
 * to carrying everything a reader needs in order to distrust the number.
 */

const spec = (() => {
  const parsed = parseFormulaSpec({
    id: 'shared-model',
    name: 'Shared model',
    source: { standard: 'Example standard', part: '3', edition: '2024', sections: ['5.3'] },
    unitSystem: 'USC',
    variables: [
      { symbol: 'Ps', name: 'Storage pressure', unit: 'lbf/in2 (abs)', role: 'input' },
      { symbol: 'k', role: 'constant', value: 1.5 },
    ],
    expressions: [
      {
        id: 'sound',
        equation: '3.6',
        resultSymbol: 'W',
        unit: 'lb/sec',
        expression: '{Ps} * {k}',
        latex: 'W = P_s k',
      },
      {
        id: 'guessed',
        equation: '3.7',
        expression: '{Ps} / {k}',
        unverified: 'Supplied from memory; the source never defines it.',
      },
    ],
    piecewise: [],
    lookups: [
      {
        id: 'fact_di',
        name: 'Reduction factor',
        keys: ['detection'],
        result: 'fact_di',
        domains: { detection: ['A', 'B', 'C'] },
        rows: [
          { detection: 'A', fact_di: 0.25 },
          { detection: 'B', fact_di: 0.1 },
        ],
      },
    ],
    classifications: [
      {
        id: 'detection-rating',
        domain: ['A', 'B', 'C'],
        criteria: {
          A: 'Instrumentation designed specifically to detect material losses.',
          B: 'Suitably located detectors.',
          C: 'Visual detection only.',
        },
      },
    ],
    notes: { transition: 'The source branches on a threshold it never defines.' },
  });
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.spec;
})();

const html = renderToStaticMarkup(
  createElement(FormulaPresenter, {
    view: {
      title: 'Shared model',
      spec,
      coverageGaps: checkLookupCoverage(spec),
      dimensionIssues: checkDimensions(spec),
    },
    // The /s surface's shape: pre-rendered island markup behind its own
    // dangerouslySetInnerHTML wrapper (the /team reader mounts the live
    // component instead — the prop is a ReactNode either way).
    calculator: createElement('div', {
      dangerouslySetInnerHTML: { __html: '<div data-island="formula-calculator"></div>' },
    }),
  }),
);

describe('FormulaPresenter', () => {
  it('renders the title and a full citation', () => {
    expect(html).toContain('Shared model');
    expect(html).toContain('Example standard Part 3 (2024)');
    expect(html).toContain('§5.3');
  });

  it('warns about an unverified equation WITHOUT any JavaScript', () => {
    // The whole reason the static half exists. If this ever moves into the
    // island, a visitor with a blocked bundle reads a fabricated equation
    // number as though it were transcribed.
    expect(html).toContain('not read from the source');
    expect(html).toContain('Supplied from memory');
    expect(html).toContain('guessed');
  });

  it('names the key combinations the source leaves unspecified', () => {
    // detection=C is declared legal but has no row.
    expect(html).toContain('unspecified');
  });

  it('renders the equations, the lookup rows and the rating criteria', () => {
    expect(html).toContain('Eq 3.6');
    expect(html).toContain('0.25');
    expect(html).toContain('Instrumentation designed specifically');
  });

  it('keeps the transcription notes — what the source got wrong travels too', () => {
    expect(html).toContain('branches on a threshold it never defines');
  });

  it('mounts the calculator island', () => {
    expect(html).toContain('data-island="formula-calculator"');
  });

  it('renders LaTeX server-side rather than shipping the source string raw', () => {
    // KaTeX output, not the `latex` field verbatim.
    expect(html).toContain('katex');
  });
});
