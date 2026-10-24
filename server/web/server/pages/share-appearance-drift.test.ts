/**
 * The /s render path for the saved background (Drift): what the brain stores
 * reaches the reader's host div as one canonical spec the share-page runtime
 * decodes, through the same codec the brain validated it with. v1 (Neat era)
 * and v2 both paint; garbage, an unknown version and shareNeat OFF render the
 * plain themed surface with no host div at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeDriftSpec } from '@mantle/content-core/drift-spec';

const h = vi.hoisted(() => ({ prefs: {} as Record<string, unknown> }));

vi.mock('@mantle/content', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@mantle/content')>()),
  loadProfilePreferences: vi.fn(async () => h.prefs),
}));

const { loadShareAppearance } = await import('./appearance');
const { htmlPage } = await import('./template');

const V2 =
  '{"v":2,"seed":9,"tone":"auto","speed":2,"style":"aurora","pal":"chart","str":0.4,"scale":1,"warp":0.5,"soft":0.6,"light":0.5,"grain":0.12,"angle":30}';

const reader = (neat: string | null) =>
  htmlPage({ title: 'T', share: { defaultMode: 'light', neat, readerChrome: true } }, '<p>b</p>');

describe('the /s reader and the saved background', () => {
  beforeEach(() => {
    h.prefs = {};
  });

  it('carries a v2 spec to the host div unchanged', async () => {
    h.prefs = { neatBackground: V2 };
    const { neatBackground } = await loadShareAppearance('owner-1');
    expect(neatBackground).toBe(V2);
    const html = reader(neatBackground);
    expect(html).toContain('data-neat-spec="{&quot;v&quot;:2');
    expect(html).toContain('src="/share-runtime/share-page.js"');
  });

  it('paints a Neat-era v1 spec, as silk', async () => {
    h.prefs = { neatBackground: '{"v":1,"seed":7,"tone":"darker","speed":3}' };
    const { neatBackground } = await loadShareAppearance('owner-1');
    expect(decodeDriftSpec(neatBackground)).toMatchObject({
      v: 2,
      style: 'silk',
      seed: 7,
      tone: 'darker',
      speed: 3,
    });
  });

  it('renders no host div for garbage, an unknown version or OFF', async () => {
    for (const bad of ['{broken', '{"v":7,"seed":1}', '']) {
      h.prefs = { neatBackground: bad };
      const { neatBackground } = await loadShareAppearance('owner-1');
      expect(neatBackground, bad).toBeNull();
      expect(reader(neatBackground)).not.toContain('data-neat-spec');
    }
  });

  it('honours shareNeat OFF', async () => {
    h.prefs = { neatBackground: V2, shareNeat: false };
    expect((await loadShareAppearance('owner-1')).neatBackground).toBeNull();
  });
});
