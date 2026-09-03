/**
 * Behavioural tests for formula_create and formula_update. Neither had one.
 *
 * A formula is a transcription of a published standard, and the whole point
 * of storing it is that the number it produces can be checked. Two things
 * are worth pinning at the tool edge:
 *
 *  - the store's validation error comes back VERBATIM, because the create
 *    description promises "every problem is returned at once" and a tool
 *    that paraphrased or truncated it would break that promise;
 *  - update sends `spec` and `tags` ONLY when passed. There is no partial
 *    spec merge, so a spec key set to undefined would be a request to
 *    replace the model with nothing; and tags omitted must not clear.
 *
 * Both success arms also surface `coverage_gaps` and `dimension_issues`
 * from the stored spec: the checks run on what LANDED, not on the input.
 *
 * The store and the two pure checkers are stubbed; the tools' coercion and
 * patch shaping are real.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    createFormula: vi.fn(),
    updateFormula: vi.fn(),
    checkLookupCoverage: vi.fn(() => []),
    checkDimensions: vi.fn(() => []),
    nodeUrl: (id: string) => `https://brain.test/n/${id}`,
  };
});

import {
  createFormula,
  updateFormula,
  checkLookupCoverage,
  checkDimensions,
} from '@mantle/content';
import { FORMULA_TOOLS } from './builtins-formulas';
import type { BuiltinToolDef, ToolHandlerContext } from './types';

const ctx: ToolHandlerContext = { ownerId: 'o1' };
const ID = '11111111-2222-4333-8444-555555555555';

const create = FORMULA_TOOLS.find((t) => t.slug === 'formula_create')!;
const update = FORMULA_TOOLS.find((t) => t.slug === 'formula_update')!;

type Result = Awaited<ReturnType<BuiltinToolDef['handler']>>;

function errorOf(res: Result): string {
  if (res.ok) throw new Error(`expected a failure, got ok with ${JSON.stringify(res.output)}`);
  return res.error;
}

function outputOf(res: Result): Record<string, unknown> {
  if (!res.ok) throw new Error(`expected success, got error: ${res.error}`);
  return res.output as Record<string, unknown>;
}

const spec = {
  id: 'release-rate',
  name: 'Release rate',
  source: { standard: 'API RP 581' },
  variables: [],
  expressions: [],
  piecewise: [],
  lookups: [],
  classifications: [],
};
const stored = {
  id: ID,
  title: 'Release rate',
  spec,
  tags: ['api-581'],
  summary: null,
  updatedAt: 'x',
};
const GAP = { lookup: 'table-4', missing: { fluid: 'steam' } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createFormula).mockResolvedValue(stored as never);
  vi.mocked(updateFormula).mockResolvedValue(stored as never);
  vi.mocked(checkLookupCoverage).mockReturnValue([] as never);
  vi.mocked(checkDimensions).mockReturnValue([] as never);
});

describe('formula_create', () => {
  it('returns the store validation error verbatim so every problem reaches the model', async () => {
    const all = 'spec invalid: variables[0].symbol missing; expressions[1] references unknown k';
    vi.mocked(createFormula).mockRejectedValue(new Error(all));

    expect(errorOf(await create.handler({ spec: { id: 'bad' } }, ctx))).toBe(all);
  });

  it('stores under the owner and reports gaps from the spec that LANDED', async () => {
    vi.mocked(checkLookupCoverage).mockReturnValue([GAP] as never);

    const res = await create.handler({ spec, title: ' Release rate ', tags: ['api-581', 9] }, ctx);

    expect(createFormula).toHaveBeenCalledWith('o1', {
      spec,
      title: 'Release rate',
      tags: ['api-581'],
    });
    // The checkers see the stored row's spec, not the raw argument.
    expect(checkLookupCoverage).toHaveBeenCalledWith(stored.spec);
    expect(outputOf(res)).toMatchObject({
      id: ID,
      standard: 'API RP 581',
      coverage_gaps: [GAP],
      dimension_issues: [],
    });
  });
});

describe('formula_update', () => {
  it('reports a miss as a failure that names formula_list', async () => {
    vi.mocked(updateFormula).mockResolvedValue(null);
    const err = errorOf(await update.handler({ id: ID, title: 'x' }, ctx));
    expect(err).toMatch(/not found/i);
    expect(err).toMatch(/formula_list/);
  });

  it('a title-only patch carries NO spec and NO tags key', async () => {
    await update.handler({ id: ID, title: 'Renamed' }, ctx);

    const patch = vi.mocked(updateFormula).mock.calls[0]![2] as Record<string, unknown>;
    expect(patch.title).toBe('Renamed');
    // Presence, not value: `spec: undefined` would read as "replace the
    // whole model with nothing", and `tags: undefined` as "clear".
    expect('spec' in patch).toBe(false);
    expect('tags' in patch).toBe(false);
    expect(updateFormula).toHaveBeenCalledWith('o1', ID, expect.anything());
  });

  it('a whole-spec replacement goes through with its tags and surfaces dimension issues', async () => {
    const issue = { symbol: 'W', declared: 'lb/s', derived: 'kg/s' };
    vi.mocked(checkDimensions).mockReturnValue([issue] as never);

    const res = await update.handler({ id: ID, spec, tags: [] }, ctx);

    expect(updateFormula).toHaveBeenCalledWith('o1', ID, { spec, title: undefined, tags: [] });
    expect(outputOf(res)).toMatchObject({ id: ID, dimension_issues: [issue] });
  });
});
