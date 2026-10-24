/**
 * The kind lists of @mantle/content and the packages below it, derived from
 * the kind registry (@mantle/client-types/kinds, workspaces arch A1). Each is
 * pinned to its value before the registry (v0.300.2): widening one is a
 * reviewed edit here. The trap this guards: CONTACT_SHAREABLE_TYPES used to
 * derive from WORKSPACE_NODE_TYPES, so the workspace class gaining task,
 * event and recall (D1) would have opened them to contact shares silently.
 *
 * Order: the tree lists keep theirs (the shell's `treeKinds`, a tool enum);
 * the others are pinned as sets (the code asks membership only).
 */
import { describe, expect, it } from 'vitest';
import { WORKSPACE_NODE_TYPES } from '@mantle/db';
import {
  TEAM_NEVER_TYPES,
  TEAM_PRIVATE_CORPUS_TYPES,
} from '@mantle/content-core/profile-projections';
import { SHAREABLE_TYPES, canShareNode } from './shares';
import { CONTACT_SHAREABLE_TYPES } from './contact-shares';
import { PEER_SHAREABLE_TYPES } from './peers';
import { READER_TREE_KINDS, TREE_LIVE_KINDS } from './tree/kinds';
import { isWorkspaceKind } from './access';

const set = (xs: readonly string[]) => [...xs].sort();

describe('kind lists derived from the registry', () => {
  it('WORKSPACE_NODE_TYPES: the workspace class (D1 adds task, event, recall)', () => {
    // Before A1: page, note, draw, table, file, branch, app, formula.
    expect(set(WORKSPACE_NODE_TYPES)).toEqual(
      set([
        'page',
        'note',
        'draw',
        'table',
        'file',
        'branch',
        'app',
        'formula',
        // Owner decision D1 (2026-10-12): workspace kinds on every surface.
        'task',
        'event',
        'recall',
        // Present (0331): a workspace kind like draw.
        'present',
      ]),
    );
    expect(isWorkspaceKind('task')).toBe(true);
    expect(isWorkspaceKind('journal')).toBe(false);
  });

  it('CONTACT_SHAREABLE_TYPES did not follow the class: no task, event or recall', () => {
    expect(set(CONTACT_SHAREABLE_TYPES)).toEqual(
      set(['page', 'note', 'draw', 'table', 'file', 'app', 'formula']),
    );
  });

  it('SHAREABLE_TYPES and canShareNode', () => {
    expect(set(SHAREABLE_TYPES)).toEqual(
      set(['page', 'note', 'task', 'event', 'file', 'app', 'table', 'formula', 'draw', 'branch']),
    );
    expect(canShareNode({ type: 'page', path: 'pages' })).toBe(true);
    expect(canShareNode({ type: 'branch', path: 'files.work' })).toBe(true);
    expect(canShareNode({ type: 'branch', path: 'files' })).toBe(false);
    expect(canShareNode({ type: 'branch', path: 'pages.work' })).toBe(false);
    expect(canShareNode({ type: 'branch', path: null })).toBe(false);
    expect(canShareNode({ type: 'recall', path: 'recall' })).toBe(false);
    expect(canShareNode({ type: 'journal', path: 'journal' })).toBe(false);
    expect(canShareNode({ type: 'no-such-kind', path: null })).toBe(false);
  });

  it('PEER_SHAREABLE_TYPES', () => {
    expect(set(PEER_SHAREABLE_TYPES)).toEqual(
      set(['page', 'note', 'file', 'contact', 'table', 'draw', 'event', 'task']),
    );
  });

  it('TREE_LIVE_KINDS keeps its order (the shell sends it)', () => {
    expect(TREE_LIVE_KINDS).toEqual([
      'files',
      'notes',
      'pages',
      'draw',
      'tables',
      'formulas',
      'tasks',
      'events',
      'contacts',
      'secrets',
      'apps',
      'recall',
      // Present, appended.
      'present',
    ]);
  });

  it('READER_TREE_KINDS keeps its order', () => {
    expect(READER_TREE_KINDS).toEqual(['files', 'notes', 'pages', 'draw', 'tables']);
  });

  it('TEAM_PRIVATE_CORPUS_TYPES and TEAM_NEVER_TYPES', () => {
    expect(set(TEAM_PRIVATE_CORPUS_TYPES)).toEqual(set(['email', 'email_thread', 'journal']));
    expect(set(TEAM_NEVER_TYPES)).toEqual(
      set(['secret', 'telegram_message', 'location', 'mantle_peer']),
    );
  });
});
