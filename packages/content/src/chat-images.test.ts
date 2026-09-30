/**
 * Pictures in a member's or a client's chat thread (client logins C6), the
 * pure half: which items the images name, and the text as its reader gets
 * it. An image of a readable file or drawing points at the reader's own
 * route; every other image (above the level, not an item, external, data:,
 * a form the pass does not know) is left out or cannot draw. The lookup at
 * the reader's level is proven on Postgres in chat-images.viewer.db.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { chatImageIds, chatImageSrc, rewriteChatImages, type ChatImageKind } from './chat-images';
import { clientOwnUrl } from './client-redact';

const FILE = '11111111-1111-4111-8111-111111111111';
const DRAW = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const own = clientOwnUrl(['https://brain.example.invalid']);
const readable = new Map<string, ChatImageKind>([
  [FILE, 'file'],
  [DRAW, 'draw'],
]);
const rw = (text: string, reader: 'team' | 'client' = 'client') =>
  rewriteChatImages(text, readable, reader, own);

describe('chatImageIds', () => {
  it('reads the schemes, the owner routes, the reader routes and brain URLs', () => {
    const text = [
      `![a](media:${FILE})`,
      `![b](draw:${DRAW})`,
      `![c](/api/files/files/${ADMIN}?raw=1)`,
      `![d](https://brain.example.invalid/api/files/files/${FILE}?raw=1)`,
      `![e](<MEDIA:${ADMIN.toUpperCase()}>)`,
      '![f](https://elsewhere.example.invalid/x.png)',
      '![g](data:image/png;base64,AAAA)',
      `![h](/api/x/${FILE}/${ADMIN})`,
      `[a link](/api/files/files/${ADMIN})`,
    ].join('\n');
    expect(chatImageIds([text], own).sort()).toEqual([FILE, DRAW, ADMIN].sort());
  });

  it('reads a reference-style image through its definition', () => {
    const text = `see ![pic][p]\n\n[p]: /api/files/files/${ADMIN}?raw=1`;
    expect(chatImageIds([text], own)).toEqual([ADMIN]);
  });
});

describe('rewriteChatImages', () => {
  it('points a readable file or drawing at the client’s own routes', () => {
    expect(rw(`look ![the plan](media:${FILE}) here`)).toBe(
      `look ![the plan](/api/client/files/${FILE}) here`,
    );
    expect(rw(`![x](/api/files/files/${FILE}?raw=1)`)).toBe(`![x](/api/client/files/${FILE})`);
    expect(rw(`![x](https://brain.example.invalid/api/files/files/${FILE}?raw=1)`)).toBe(
      `![x](/api/client/files/${FILE})`,
    );
    expect(rw(`![x](draw:${DRAW})`)).toBe(`![x](/api/client/draws/${DRAW}/svg)`);
    expect(rw(`![x](/api/draws/${DRAW}/svg?raw=1 "title")`)).toBe(
      `![x](/api/client/draws/${DRAW}/svg)`,
    );
  });

  it('points them at the member’s routes for a member', () => {
    expect(rw(`![x](media:${FILE})`, 'team')).toBe(`![x](/api/member/files/${FILE})`);
    expect(rw(`![x](draw:${DRAW})`, 'team')).toBe(`![x](/api/member/draws/${DRAW}/svg)`);
    expect(chatImageSrc('team', 'file', FILE)).toBe(`/api/member/files/${FILE}`);
  });

  it('leaves out every other image: above the level, external, data:, two ids', () => {
    for (const target of [
      `media:${ADMIN}`,
      `/api/files/files/${ADMIN}?raw=1`,
      `https://brain.example.invalid/api/files/files/${ADMIN}?raw=1`,
      `/api/client/files/${ADMIN}`,
      'https://elsewhere.example.invalid/pixel.png',
      '//elsewhere.example.invalid/pixel.png',
      'data:image/png;base64,AAAA',
      `/api/x/${FILE}/${ADMIN}`,
      'javascript:alert',
      'media:not-a-uuid',
    ]) {
      const out = rw(`a ![secret](${target}) b`);
      expect(out, target).toBe('a  b');
    }
  });

  it('never points the reader at an owner route, whatever the form', () => {
    const text = [
      `![a](media:${ADMIN})`,
      `![b][r]`,
      `![c [nested] alt](/api/files/files/${ADMIN}?raw=1)`,
      `<img src="/api/files/files/${ADMIN}?raw=1">`,
      '![d](javascript:alert(1))',
      '',
      `[r]: /api/files/files/${ADMIN}?raw=1`,
    ].join('\n');
    const out = rw(text);
    // No image form survives that could draw the admin file: the nested-alt
    // form is escaped (a link at most), the raw <img> shown as text.
    expect(out).not.toMatch(/!\[/);
    expect(out).not.toMatch(/<img/i);
    expect(out).toContain('!\\[c [nested] alt]');
    expect(out).toContain('&lt;img');
  });

  it('a reference-style image of a readable file becomes the reader’s route', () => {
    const out = rw(`see ![pic][p]\n\n[p]: /api/files/files/${FILE}?raw=1`);
    expect(out).toContain(`![pic](/api/client/files/${FILE})`);
  });

  it('leaves text without images, and links, as they are', () => {
    const text = `a [link](/api/files/files/${ADMIN}) and **bold**`;
    expect(rw(text)).toBe(text);
    expect(rw('')).toBe('');
  });
});
