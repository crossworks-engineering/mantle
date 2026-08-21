/**
 * Drift gate for the `read_only` turn preset.
 *
 * The preset is default-deny, so the dangerous direction is a WRITE tool that
 * gets marked read-only by mistake — that ships a probe which can quietly send
 * mail. These tests make that mistake loud at CI time rather than at 3am on a
 * customer box. They deliberately do NOT assert an exact snapshot of the
 * read-only set: adding a genuine read must stay a one-line change, or authors
 * will stop marking reads and the preset rots into uselessness.
 */

import { describe, it, expect } from 'vitest';
import { listBuiltins, listReadOnlyBuiltinSlugs, isBuiltinReadOnly } from './registry';

/** Verb fragments that can only belong to a tool that changes something or
 *  sends something. A slug carrying one of these must never be read-only. */
const WRITE_VERBS = [
  'create',
  'update',
  'delete',
  'remove',
  'set',
  'add',
  'append',
  'write',
  'send',
  'notify',
  'share',
  'unshare',
  'publish',
  'commit',
  'discard',
  'upload',
  'rename',
  'move',
  'split',
  'seed',
  'build',
  'ensure',
  'grant',
  'pair',
  'approve',
  'reject',
  'cancel',
  'stop',
  'exec',
  'supersede',
  'upsert',
];

describe('read_only preset classification', () => {
  it('marks no tool whose slug carries a write verb', () => {
    const offenders = listReadOnlyBuiltinSlugs().filter((slug) =>
      WRITE_VERBS.some((v) => slug.split('_').includes(v)),
    );
    expect(offenders).toEqual([]);
  });

  it('marks no tool that requires operator confirmation', () => {
    // requiresConfirm exists precisely because the call is consequential.
    const offenders = listBuiltins()
      .filter((d) => d.readOnly === true && d.requiresConfirm === true)
      .map((d) => d.slug);
    expect(offenders).toEqual([]);
  });

  it('never marks invoke_agent — a child agent carries its own write grants', () => {
    expect(isBuiltinReadOnly('invoke_agent')).toBe(false);
  });

  it('defaults to deny for unknown and user-defined tools', () => {
    expect(isBuiltinReadOnly('some_api_tool_the_user_made')).toBe(false);
    expect(isBuiltinReadOnly('')).toBe(false);
  });

  it('still marks a useful core of reads, so the preset is worth using', () => {
    // A canary that cannot search or read a node proves nothing. If this fails,
    // someone stripped the markers rather than fixing a real misclassification.
    for (const slug of ['search_nodes', 'search_chunks', 'node_read', 'page_get']) {
      expect(isBuiltinReadOnly(slug), `${slug} should be read-only`).toBe(true);
    }
    expect(listReadOnlyBuiltinSlugs().length).toBeGreaterThan(50);
  });
});
