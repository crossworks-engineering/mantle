/**
 * importAppPackage grants NO tools (apps audit 2026-10-02, item 1). A
 * package is a file from anywhere; its declared tools would run as the owner
 * the moment the published app opens. The new app's allowlist is empty and
 * the declared tools come back as requested (this brain has them) or dropped
 * (it does not).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mantle/content', () => ({
  NoGreenBuildError: class extends Error {},
  notifyAppNavChanged: vi.fn(async () => {}),
  publishApp: vi.fn(async () => ({})),
  saveDraftSource: vi.fn(async () => ({})),
}));
vi.mock('@mantle/content/app-broker', () => ({ checkAppSchemaScript: vi.fn(async () => {}) }));
vi.mock('@mantle/content/app-package', () => ({
  AppPackageError: class extends Error {},
  openAppPackage: vi.fn(),
  installAppPackage: vi.fn(),
}));
vi.mock('@mantle/tracing', () => ({ recordIngest: vi.fn(async () => {}) }));
vi.mock('./app-build-stage', () => ({
  buildAndStageApp: vi.fn(async () => ({ buildOk: true, errors: [], warnings: [], bytes: 1 })),
}));
vi.mock('./resolve', () => ({
  resolveTool: vi.fn(async (_o: string, slug: string) => (slug === 'nope' ? null : { slug })),
}));

import { installAppPackage, openAppPackage } from '@mantle/content/app-package';
import { publishApp } from '@mantle/content';
import { importAppPackage } from './app-package-import';

beforeEach(() => vi.clearAllMocks());

describe('importAppPackage', () => {
  it('installs with an empty allowlist and reports the declared tools', async () => {
    vi.mocked(openAppPackage).mockResolvedValueOnce({
      pkg: {
        manifest: { toolSlugs: ['access_set', 'web_fetch', 'nope', 'web_fetch'] },
        code: { published: { files: {} }, draft: null },
        data: null,
      },
      extractData: vi.fn(),
    } as never);
    vi.mocked(installAppPackage).mockResolvedValueOnce({ id: 'a1', title: 'X' } as never);

    const res = await importAppPackage('o1', Buffer.from('zip'));

    expect(vi.mocked(installAppPackage).mock.calls[0]![2]).toMatchObject({ toolSlugs: [] });
    expect(res.requestedToolSlugs).toEqual(['access_set', 'web_fetch']);
    expect(res.droppedToolSlugs).toEqual(['nope']);
    // Still published: the code runs, but with no tools.
    expect(publishApp).toHaveBeenCalledOnce();
    expect(res.published).toBe(true);
  });
});
