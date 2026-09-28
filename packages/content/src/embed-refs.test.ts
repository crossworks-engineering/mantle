import { describe, expect, it } from 'vitest';
import { cellRefs, noteRefs, pageRefs, sceneRefs } from './embed-refs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const E = '55555555-5555-4555-8555-555555555555';
const F = '66666666-6666-4666-8666-666666666666';

const para = (...content: unknown[]) => ({ type: 'paragraph', content });
const text = (t: string, href?: string) => ({
  type: 'text',
  text: t,
  ...(href ? { marks: [{ type: 'link', attrs: { href } }] } : {}),
});

/** Audit S2: the embed rule sees every reference type, not only images and
 *  node mentions. */
describe('pageRefs', () => {
  it('collects ids from every node attribute, mention and link', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { nodeId: A } },
        { type: 'pageImage', attrs: { drawId: B } },
        { type: 'childPage', attrs: { pageId: C, title: 'x' } },
        { type: 'fileEmbed', attrs: { nodeId: null, href: `/api/member/space/${D}/bytes` } },
        para(
          { type: 'mention', attrs: { id: E, ref: 'node' } },
          text('see', `/n/${F}#${A}`),
          text('media', `media:${A}`),
        ),
      ],
    };
    const r = pageRefs(doc);
    expect(r.ids.sort()).toEqual([A, B, C, D, E, F].sort());
    expect(r.refused).toEqual([]);
  });

  it('refuses non-uuid ids, entity mentions, external images and odd schemes', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { nodeId: 'not-a-uuid' } },
        { type: 'image', attrs: { src: 'https://tracker.example/p.gif' } },
        { type: 'childPage', attrs: { pageId: 'abc' } },
        para(
          { type: 'mention', attrs: { id: A, ref: 'entity' } },
          { type: 'mention', attrs: { id: B } },
          text('js', 'javascript:alert(1)'),
          text('mention link', `mention:entity:${C}`),
        ),
      ],
    };
    const r = pageRefs(doc);
    expect(r.ids).toEqual([]);
    expect(r.refused.sort()).toEqual(
      [
        'not-a-uuid',
        'https://tracker.example/p.gif',
        'abc',
        `mention:entity:${A}`,
        `mention:entity:${B}`,
        'javascript:alert(1)',
        `mention:entity:${C}`,
      ].sort(),
    );
  });

  it('reads a scheme as the browser does: controls and whitespace do not hide it', () => {
    const sneaky = [
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      '\u0001javascript:alert(1)',
      'jav\u0000ascript:alert(1)',
      'VBScript:msgbox(1)',
      'vb\tscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      'da\tta:text/html,x',
    ];
    const doc = {
      type: 'doc',
      content: [
        para(...sneaky.map((href) => text('x', href))),
        // An image src: a non-image data: URL and a hidden script are refused;
        // data:image/ stays allowed, as before.
        { type: 'image', attrs: { src: 'java\tscript:alert(1)' } },
        { type: 'image', attrs: { src: 'data:text/html,x' } },
        { type: 'image', attrs: { src: 'data:image/png;base64,AAAA' } },
      ],
    };
    const r = pageRefs(doc);
    expect(r.ids).toEqual([]);
    expect(r.refused.sort()).toEqual([...sneaky, 'data:text/html,x'].sort());
    // A hidden-scheme value never reads as a relative path of ids either.
    expect(pageRefs({ type: 'doc', content: [para(text('x', `java\tscript:/n/${A}`))] })).toEqual({
      ids: [],
      refused: [`java\tscript:/n/${A}`],
      embeds: [],
    });
  });

  it('leaves plain links, anchors and inline images alone', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: 'data:image/png;base64,AAAA' } },
        para(
          text('web', 'https://example.com/a'),
          text('mail', 'mailto:ann@example.com'),
          text('anchor', `#${A}`),
          text('list', '/pages'),
        ),
      ],
    };
    expect(pageRefs(doc)).toEqual({ ids: [], refused: [], embeds: [] });
  });
});

/** Phase 4: Accept moves what renders inside an item and leaves links. */
describe('embeds vs links', () => {
  it('counts ids, src and href on a node as embeds; marks and mentions as links', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'image', attrs: { nodeId: A } },
        { type: 'image', attrs: { src: `media:${B}` } },
        { type: 'childPage', attrs: { pageId: C } },
        { type: 'fileEmbed', attrs: { href: `/api/member/space/${D}/bytes` } },
        para(
          { type: 'mention', attrs: { id: E, ref: 'node' } },
          text('see', `/n/${F}`),
          text('also', `media:${A}`),
        ),
      ],
    };
    const r = pageRefs(doc);
    expect(r.embeds.sort()).toEqual([A, B, C, D].sort());
    expect(r.ids.sort()).toEqual([A, B, C, D, E, F].sort());
  });

  it('never counts a drawing element link or a table cell as an embed', () => {
    expect(sceneRefs({ elements: [{ type: 'rectangle', link: `media:${A}` }] }).embeds).toEqual([]);
    expect(cellRefs([`media:${A}`]).embeds).toEqual([]);
  });
});

describe('noteRefs', () => {
  it('reads references out of a note’s markdown', () => {
    const r = noteRefs(
      `Plan: see [the spec](page:${A}) and ![x](media:${B}).\n\n[Ann](mention:node:${C})`,
    );
    expect(r.ids.sort()).toEqual([A, B, C].sort());
    expect(noteRefs('Note: call Ann at 10:30').ids).toEqual([]);
    expect(noteRefs('![pixel](https://tracker.example/p.gif)').refused).toEqual([
      'https://tracker.example/p.gif',
    ]);
  });
});

describe('sceneRefs', () => {
  it('reads element links; an embedded frame is a source', () => {
    const r = sceneRefs({
      elements: [
        { type: 'rectangle', link: `/pages/${A}` },
        { type: 'text', link: 'https://example.com' },
        { type: 'embeddable', link: 'https://tracker.example/frame' },
        { type: 'rectangle', link: `/pages/${B}`, isDeleted: true },
      ],
    });
    expect(r).toEqual({ ids: [A], refused: ['https://tracker.example/frame'], embeds: [] });
  });
});

describe('cellRefs', () => {
  it('treats only app schemes and paths as references in free text', () => {
    const r = cellRefs([
      `page:${A}`,
      `/n/${B}`,
      'Note: call Ann',
      'https://example.com',
      42,
      'v:1',
    ]);
    expect(r).toEqual({ ids: [A, B], refused: [], embeds: [] });
    expect(cellRefs(['media:nope']).refused).toEqual(['nope']);
  });
});
