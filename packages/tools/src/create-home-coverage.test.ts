/**
 * A tool that makes an item is never readOnly (A0 fix round 3, M-a): an
 * assistant turn makes the login's private workspace for any tool that is
 * not readOnly (dispatch.ts, turn-create-home.ts), so a create flagged
 * readOnly would land a Team reader's first item in Admin or the folder's
 * home. A static sweep over the builtins: every listed create, every
 * Admin-only create, and every builtin whose slug says it makes something.
 */
import { describe, expect, it } from 'vitest';
import { CREATE_TOOL_SLUGS } from './create-tools';
import { getBuiltin, listBuiltins } from './registry';

/** Slugs that make an item by name. */
const MAKES =
  /_(create|from_[a-z_]+|copy|duplicate|import|export|upload|save|split|extract_section|build)$/;

/** Named like a create but makes nothing: it reads an image and returns
 *  its text. */
const MAKES_NOTHING = new Set(['extract_from_image']);

/** Builtins known to make a node without a create name. */
const ALSO_MAKES = ['export_node', 'sandbox_export', 'generate_image', 'sheet_build'];

describe('a tool that makes an item is not readOnly', () => {
  it('covers every listed create and every builtin named as one', () => {
    const slugs = new Set<string>([...CREATE_TOOL_SLUGS, ...ALSO_MAKES]);
    for (const def of listBuiltins()) {
      if (MAKES.test(def.slug) && !MAKES_NOTHING.has(def.slug)) slugs.add(def.slug);
    }
    const flagged: string[] = [];
    const missing: string[] = [];
    for (const slug of slugs) {
      const def = getBuiltin(slug);
      if (!def) missing.push(slug);
      else if (def.readOnly === true) flagged.push(slug);
    }
    expect(missing, 'listed but no builtin now: drop it').toEqual([]);
    expect(flagged, 'a tool that makes an item may not be readOnly').toEqual([]);
    expect(slugs.size).toBeGreaterThan(30);
  });
});
