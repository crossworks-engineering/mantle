/**
 * The author ceiling and a dry run (code tools audit, H1): only code_edit,
 * whose dry run writes nothing, skips lowering the app for `dry_run: true`.
 * Any other app write lowers whatever its input says, since an argument it
 * does not declare can still reach the handler (a run item).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../outside-admin', () => ({ scopeOutsideAdmin: vi.fn(async () => true) }));
vi.mock('@mantle/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/db')>();
  // The caller manages the app (lowerToTeamRules asks it first).
  return { ...actual, db: { ...actual.db, execute: vi.fn(async () => [{ manage: true }]) } };
});
vi.mock('@mantle/content', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mantle/content')>();
  return {
    ...actual,
    setAppAuthorLevel: vi.fn(async () => true),
    changeDraftSource: vi.fn(async () => null),
  };
});

import { setAppAuthorLevel } from '@mantle/content';
import { APP_TOOLS } from '../builtins-apps';
import type { ToolHandlerContext } from '../types';
import { CODE_TOOLS } from './tools';

const ctx: ToolHandlerContext = { ownerId: 'o1', surface: { kind: 'web' } };
const APP_ID = '11111111-2222-4333-8444-555555555555';
const call = (slug: string, input: Record<string, unknown>) =>
  [...APP_TOOLS, ...CODE_TOOLS].find((t) => t.slug === slug)!.handler(input, ctx);

beforeEach(() => vi.clearAllMocks());

describe('dry_run and the author ceiling', () => {
  it('a code_edit dry run lowers nothing', async () => {
    await call('code_edit', {
      target: `app:${APP_ID}`,
      path: 'App.tsx',
      edits: [{ old: 'a', new: 'b' }],
      dry_run: true,
    });
    expect(setAppAuthorLevel).not.toHaveBeenCalled();
  });

  it.each([
    ['app_file_write', { id: APP_ID, path: 'a.ts', content: 'x', dry_run: true }],
    ['app_source_set', { id: APP_ID, entry: 'A.tsx', files: { 'A.tsx': 'x' }, dry_run: true }],
    ['code_write', { target: `app:${APP_ID}`, path: 'a.ts', content: 'x', dry_run: true }],
    ['code_undo', { target: `app:${APP_ID}`, path: 'a.ts', dry_run: true }],
  ])('%s with an undeclared dry_run still lowers the app', async (slug, input) => {
    await call(slug, input);
    expect(setAppAuthorLevel).toHaveBeenCalledWith('o1', APP_ID, 'team');
  });

  it('a code_edit that is not a dry run lowers the app', async () => {
    await call('code_edit', {
      target: `app:${APP_ID}`,
      path: 'App.tsx',
      edits: [{ old: 'a', new: 'b' }],
    });
    expect(setAppAuthorLevel).toHaveBeenCalledWith('o1', APP_ID, 'team');
  });
});
