import { describe, expect, it } from 'vitest';
import { resolveImageParams } from './image-params';
import type { ImageGenParam } from '@mantle/voice';

/**
 * The applied/ignored split for generate_image.
 *
 * Both real failures this logic exists to prevent were SILENT — the image came
 * back, the tool reported success, and the wrong thing had happened:
 *
 *  1. A worker default of 1024x1024 outranked a per-call "make it a 16:9
 *     banner". The trace claimed 16:9 applied; the file was square.
 *  2. An OpenRouter worker had size/style/quality saved and shown in the UI,
 *     the adapter forwarded none of them, and nothing said so.
 *
 * Until now this could only be reached by driving the whole handler with a
 * worker, an adapter, a file store and a surface, so neither case had a test
 * that pinned the decision itself.
 */
const ALL = [
  'size',
  'aspectRatio',
  'style',
  'quality',
  'negativePrompt',
] as const satisfies readonly ImageGenParam[];

const run = (
  input: Record<string, unknown>,
  saved: Record<string, unknown>,
  supports: readonly ImageGenParam[] = ALL,
) => resolveImageParams({ input, worker: { params: saved }, supports });

const names = (rows: Array<{ param: ImageGenParam }>) => rows.map((r) => r.param).sort();

describe('resolveImageParams', () => {
  it('takes a per-call argument over the worker default', () => {
    const { get } = run({ style: 'photoreal' }, { style: 'watercolour' });
    expect(get('style')).toBe('photoreal');
  });

  it('falls back to the worker default when the call says nothing', () => {
    const { get } = run({}, { style: 'watercolour' });
    expect(get('style')).toBe('watercolour');
  });

  it('requests nothing for an option that is absent on both sides', () => {
    expect(run({}, {}).requested).toEqual([]);
  });

  it('treats an empty per-call string as absent, not as a value', () => {
    const { get } = run({ style: '' }, { style: 'watercolour' });
    expect(get('style')).toBe('watercolour');
  });

  // Failure 1.
  it('lets a per-call aspect_ratio supersede a SAVED size default', () => {
    const { get, sent, ignored } = run({ aspect_ratio: '16:9' }, { size: '1024x1024' });
    expect(get('aspectRatio')).toBe('16:9');
    expect(get('size')).toBeUndefined();
    expect(names(sent)).toEqual(['aspectRatio']);
    expect(names(ignored)).toEqual(['size']);
    expect(ignored[0]!.reason).toContain('16:9');
  });

  it('supersedes the other way round too', () => {
    const { get, ignored } = run({ size: '512x512' }, { aspect_ratio: '1:1' });
    expect(get('size')).toBe('512x512');
    expect(names(ignored)).toEqual(['aspectRatio']);
  });

  it('does NOT supersede when the CALLER asked for both sizing options', () => {
    // Supersession exists to stop a saved default outranking explicit intent.
    // Two per-call arguments are both explicit intent, so neither loses here;
    // what the provider then does with the pair is the provider's business.
    const { sent, ignored } = run({ size: '512x512', aspect_ratio: '16:9' }, {});
    expect(names(sent)).toEqual(['aspectRatio', 'size']);
    expect(ignored).toEqual([]);
  });

  it('does NOT let one saved default supersede another', () => {
    // Neither came from the call, so there is no user intent to honour.
    const { sent, ignored } = run({}, { size: '1024x1024', aspect_ratio: '16:9' });
    expect(names(sent)).toEqual(['aspectRatio', 'size']);
    expect(ignored).toEqual([]);
  });

  // Failure 2.
  it('reports options the adapter does not forward as ignored, never as sent', () => {
    const { sent, ignored, get } = run({}, { size: '1024x1024', style: 'x', quality: 'hd' }, [
      'size',
    ]);
    expect(names(sent)).toEqual(['size']);
    expect(names(ignored)).toEqual(['quality', 'style']);
    expect(get('style')).toBeUndefined();
  });

  it('records where each request came from, so the report can say which', () => {
    const { requested } = run({ style: 'photoreal' }, { quality: 'hd' });
    expect(requested.find((r) => r.param === 'style')!.fromCall).toBe(true);
    expect(requested.find((r) => r.param === 'quality')!.fromCall).toBe(false);
  });

  it('derives `supported` from the same list the split used', () => {
    const { supported } = run({}, {}, ['size', 'inputImages']);
    expect([...supported].sort()).toEqual(['inputImages', 'size']);
  });
});
