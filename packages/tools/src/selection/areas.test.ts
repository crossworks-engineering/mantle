/**
 * The tool map's area glosses (areas.ts) cover the builtin registry: every
 * area the map can draw a line for from builtins (two or more of them outside
 * the core) has a gloss, and no gloss names an area that is gone.
 */
import { describe, expect, it } from 'vitest';
import '../registry';
import { listBuiltins } from '../registry';
import { TOOL_AREA_GLOSSES } from './areas';
import { isAlwaysFull } from './deferred';

function mappableAreas(): Map<string, string[]> {
  const byArea = new Map<string, string[]>();
  for (const d of listBuiltins()) {
    if (isAlwaysFull(d.slug)) continue;
    const area = d.slug.split('_')[0]!;
    byArea.set(area, [...(byArea.get(area) ?? []), d.slug]);
  }
  return new Map([...byArea].filter(([, slugs]) => slugs.length >= 2));
}

describe('TOOL_AREA_GLOSSES', () => {
  it('has a gloss for every builtin area with two or more mapped tools', () => {
    const missing = [...mappableAreas().keys()].filter((a) => !TOOL_AREA_GLOSSES[a]).sort();
    expect(missing, 'add a gloss for each to selection/areas.ts').toEqual([]);
  });

  it('names no area the builtins no longer draw a line for', () => {
    const areas = mappableAreas();
    const stale = Object.keys(TOOL_AREA_GLOSSES).filter((a) => !areas.has(a));
    expect(stale).toEqual([]);
  });

  it('keeps each gloss short and plain', () => {
    for (const [area, gloss] of Object.entries(TOOL_AREA_GLOSSES)) {
      expect(gloss.length, area).toBeLessThanOrEqual(80);
      expect(gloss, area).not.toMatch(/[–—()\n]/);
    }
  });
});
