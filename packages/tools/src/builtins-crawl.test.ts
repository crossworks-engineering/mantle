import { describe, expect, it } from 'vitest';
import { relPathForUrl } from './builtins-crawl';

describe('relPathForUrl', () => {
  it('maps the site root to index.md', () => {
    expect(relPathForUrl(new URL('https://example.com'))).toBe('index.md');
    expect(relPathForUrl(new URL('https://example.com/'))).toBe('index.md');
  });

  it('slugifies each path segment independently', () => {
    expect(relPathForUrl(new URL('https://x.dev/SDKs/Node.JS'))).toBe('sdks/node-js.md');
  });

  it('decodes percent-encoding before slugifying', () => {
    expect(relPathForUrl(new URL('https://x.dev/a%20b/c'))).toBe('a-b/c.md');
  });

  it('collapses trailing-slash duplicates onto the same path', () => {
    expect(relPathForUrl(new URL('https://x.dev/docs/intro'))).toBe(
      relPathForUrl(new URL('https://x.dev/docs/intro/')),
    );
  });

  it('folds the query string into the stem so paginated URLs do not collide', () => {
    const bare = relPathForUrl(new URL('https://x.dev/list'));
    const paged = relPathForUrl(new URL('https://x.dev/list?page=2'));
    expect(bare).toBe('list.md');
    expect(paged).not.toBe(bare);
    expect(paged.endsWith('.md')).toBe(true);
  });

  it('never emits an empty segment for junk input', () => {
    expect(relPathForUrl(new URL('https://x.dev/%2F%2F/--/ok'))).toMatch(/^[^/]+\/[^/]+\/ok\.md$/);
  });
});
