/**
 * Contract tests for the recipe engine — the pure templating + validation +
 * safety-envelope logic that lets an agent compose existing tools into a new
 * tool. The invariants that matter:
 *
 *   1. An EXACT {param}/$ref substitutes the RAW typed value (object/array
 *      preserved), so a note body flows between steps without stringifying.
 *   2. Embedded tokens in a larger string interpolate as text.
 *   3. $ref reaches a prior step by index or `as` name, dotted into the result;
 *      an unknown step name is a hard error (authoring typo).
 *   4. The safety envelope (classifyRecipeStepTool) refuses shell, confirm-gated,
 *      and forbidden privilege builtins — the boundary that keeps recipes safe.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyRecipeStepTool,
  collectRecipeParams,
  parseRecipeSteps,
  recipeVerdictReason,
  RecipeRefError,
  resolveTemplateValue,
  type RecipeScope,
} from './recipe';

const scope = (over: Partial<RecipeScope> = {}): RecipeScope => ({
  input: { note_id: 'n1', title: 'Hi', tags: ['a', 'b'] },
  steps: { '0': { id: 'n1', content: '# Body', title: 'Note T' }, note: { id: 'n1', content: '# Body' } },
  ...over,
});

describe('resolveTemplateValue — exact tokens preserve raw type', () => {
  it('exact {param} returns the raw value, not a string', () => {
    expect(resolveTemplateValue('{tags}', scope())).toEqual(['a', 'b']);
    expect(resolveTemplateValue('{note_id}', scope())).toBe('n1');
  });

  it('exact $index ref returns the whole prior output object', () => {
    expect(resolveTemplateValue('$0', scope())).toEqual({ id: 'n1', content: '# Body', title: 'Note T' });
  });

  it('exact $name.path ref dots into a prior output', () => {
    expect(resolveTemplateValue('$0.content', scope())).toBe('# Body');
    expect(resolveTemplateValue('$note.content', scope())).toBe('# Body');
  });

  it('recurses into objects and arrays', () => {
    const out = resolveTemplateValue(
      { markdown: '$0.content', meta: { id: '{note_id}' }, list: ['{note_id}'] },
      scope(),
    );
    expect(out).toEqual({ markdown: '# Body', meta: { id: 'n1' }, list: ['n1'] });
  });
});

describe('resolveTemplateValue — embedded interpolation', () => {
  it('substitutes embedded {param} and ${ref} as text', () => {
    expect(resolveTemplateValue('${note.content} — by {title}', scope())).toBe('# Body — by Hi');
  });

  it('stringifies non-string embedded values', () => {
    expect(resolveTemplateValue('tags: {tags}', scope())).toBe('tags: ["a","b"]');
  });

  it('leaves a string with no tokens untouched', () => {
    expect(resolveTemplateValue('plain text', scope())).toBe('plain text');
  });
});

describe('resolveTemplateValue — errors', () => {
  it('throws RecipeRefError for an unknown step name', () => {
    expect(() => resolveTemplateValue('$ghost.x', scope())).toThrow(RecipeRefError);
  });

  it('a path into a shapeless value yields undefined, not a throw', () => {
    expect(resolveTemplateValue('$note.content.deeper', scope())).toBeUndefined();
  });
});

describe('collectRecipeParams', () => {
  it('collects exact + embedded params from step inputs and the output template', () => {
    const params = collectRecipeParams(
      [{ tool: 'a', input: { x: '{note_id}', y: 'hi {title}' } }],
      { z: '${0.content}', w: '{extra}' },
    );
    expect([...params].sort()).toEqual(['extra', 'note_id', 'title']);
  });
});

describe('parseRecipeSteps', () => {
  it('rejects a non-array / empty steps', () => {
    expect(parseRecipeSteps(null)).toEqual({ error: expect.stringContaining('non-empty array') });
    expect(parseRecipeSteps([])).toEqual({ error: expect.stringContaining('non-empty array') });
  });

  it('rejects a step missing a tool slug', () => {
    expect(parseRecipeSteps([{ input: {} }])).toEqual({ error: expect.stringContaining("missing a 'tool'") });
  });

  it('rejects a non-object input and a duplicate / numeric `as`', () => {
    expect(parseRecipeSteps([{ tool: 'a', input: [] }])).toEqual({ error: expect.stringContaining('input must be an object') });
    expect(
      parseRecipeSteps([
        { tool: 'a', as: 'x' },
        { tool: 'b', as: 'x' },
      ]),
    ).toEqual({ error: expect.stringContaining("reuses the name 'x'") });
    expect(parseRecipeSteps([{ tool: 'a', as: '3' }])).toEqual({ error: expect.stringContaining("'as' must be a name") });
  });

  it('normalizes a valid recipe, dropping empty input/as', () => {
    const r = parseRecipeSteps([{ tool: 'note_get', input: { id: '{note_id}' }, as: 'note' }, { tool: 'page_create' }]);
    expect(r).toEqual({ steps: [{ tool: 'note_get', input: { id: '{note_id}' }, as: 'note' }, { tool: 'page_create' }] });
  });
});

describe('classifyRecipeStepTool — the safety envelope', () => {
  it('ok for a plain composable builtin', () => {
    expect(classifyRecipeStepTool({ slug: 'note_get', exists: true, kind: 'builtin', requiresConfirm: false })).toBe('ok');
    expect(classifyRecipeStepTool({ slug: 'some_http', exists: true, kind: 'http', requiresConfirm: false })).toBe('ok');
  });

  it('missing when the tool does not exist', () => {
    expect(classifyRecipeStepTool({ slug: 'nope', exists: false })).toBe('missing');
  });

  it('forbidden for privilege/meta/terminal builtins', () => {
    for (const slug of ['run_terminal', 'secret_create', 'invoke_agent', 'agent_grant_tool_group', 'recipe_tool_create', 'web_fetch']) {
      expect(classifyRecipeStepTool({ slug, exists: true, kind: 'builtin' })).toBe('forbidden');
    }
  });

  it('shell and confirm-gated tools are refused', () => {
    expect(classifyRecipeStepTool({ slug: 'x', exists: true, kind: 'shell' })).toBe('shell');
    expect(classifyRecipeStepTool({ slug: 'y', exists: true, kind: 'builtin', requiresConfirm: true })).toBe('confirm');
  });

  it('every non-ok verdict has a human reason', () => {
    for (const v of ['missing', 'forbidden', 'shell', 'confirm'] as const) {
      expect(recipeVerdictReason('s', v).length).toBeGreaterThan(0);
    }
    expect(recipeVerdictReason('s', 'ok')).toBe('');
  });
});
