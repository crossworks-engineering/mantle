import { describe, expect, it } from 'vitest';

import { RECALL_ROOT_LABEL, ensureRecallRoot } from './recall';
import * as barrel from './index-nodes';

/**
 * Recall v2 R1: the Recall item tree's root identity.
 *
 * The label is a contract, not an implementation detail: it is the ltree root
 * every map's `path` hangs from, the `root` of the tree kind spec the client
 * reads, and the string a folder path is built on ("recall.mantle.fleet").
 * Changing it later would orphan every map row, so it is fixed here, in one
 * place, before anything depends on it.
 *
 * The root's creation itself needs a database and is exercised with the write
 * path in R2; what matters now is that the label and the function are the
 * shape the other kinds use (NOTES_ROOT_LABEL, JOURNAL_ROOT_LABEL, ...).
 */
describe('Recall root', () => {
  it("is the bare label 'recall'", () => {
    expect(RECALL_ROOT_LABEL).toBe('recall');
    // A single ltree label: no dots (those separate folders below it), and
    // nothing Postgres would refuse as a label.
    expect(RECALL_ROOT_LABEL).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('is reachable from the package barrel, like every other kind', () => {
    // The brain imports from '@mantle/content', never from the module path,
    // so a constant that is not re-exported is effectively private.
    expect(barrel.RECALL_ROOT_LABEL).toBe(RECALL_ROOT_LABEL);
    expect(typeof barrel.ensureRecallRoot).toBe('function');
    expect(barrel.ensureRecallRoot).toBe(ensureRecallRoot);
  });
});
