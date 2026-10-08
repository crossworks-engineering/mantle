import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NotePresenter } from './note-presenter';

const FILE = '11111111-1111-4111-8111-111111111111';
const DRAW = '22222222-2222-4222-8222-222222222222';
const content = [
  `![photo](media:${FILE})`,
  '',
  `![sketch](draw:${DRAW})`,
  '',
  `Read [spec.pdf](media:${FILE}) and [the site](https://example.com).`,
  '',
  '![bad](javascript:alert(1)) [bad link](javascript:alert(1))',
].join('\n');

const render = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    createElement(NotePresenter, { view: { title: 'n', content }, chrome: 'embedded', ...props }),
  );

describe('NotePresenter: media: and draw: references', () => {
  const html = render({
    assetUrl: (id: string) => `/s/tok/a/${id}`,
    drawUrl: (id: string) => `/s/tok/draw/${id}`,
  });

  it('resolves a picture and a drawing through the routes it is given', () => {
    expect(html).toContain(`<img src="/s/tok/a/${FILE}" alt="photo"/>`);
    expect(html).toContain(`<img src="/s/tok/draw/${DRAW}" alt="sketch"/>`);
  });

  it('resolves a media: file link and leaves an ordinary link alone', () => {
    expect(html).toContain(
      `<a href="/s/tok/a/${FILE}" target="_blank" rel="noopener noreferrer">spec.pdf</a>`,
    );
    expect(html).toContain('<a href="https://example.com">the site</a>');
  });

  it('keeps the default safety rule for any other scheme', () => {
    expect(html).not.toContain('javascript:');
  });

  it('without routes, draws alt text and plain text and asks for nothing', () => {
    const bare = render();
    expect(bare).not.toContain('media:');
    expect(bare).not.toContain('draw:');
    expect(bare).toContain('[photo]');
    expect(bare).toContain('[sketch]');
    expect(bare).toContain('<span>spec.pdf</span>');
    expect(bare).not.toMatch(/<img[^>]*src="[^"]*(?:11111111|22222222)/);
  });
});
