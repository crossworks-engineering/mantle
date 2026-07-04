import { describe, expect, it } from 'vitest';
import { PUBLIC_READONLY_TOOL_SLUGS, isPublicReadOnlyTool } from './readonly-tools';

describe('isPublicReadOnlyTool', () => {
  it('admits listed builtins only', () => {
    expect(
      isPublicReadOnlyTool({ slug: 'table_query', handler: { kind: 'builtin', ref: 'table_query' } }),
    ).toBe(true);
    expect(
      isPublicReadOnlyTool({ slug: 'note_get', handler: { kind: 'builtin', ref: 'note_get' } }),
    ).toBe(true);
  });

  it('denies write builtins', () => {
    for (const slug of ['note_create', 'table_row_add', 'contact_delete', 'email_send', 'app_publish']) {
      expect(isPublicReadOnlyTool({ slug, handler: { kind: 'builtin', ref: slug } })).toBe(false);
    }
  });

  it('denies privacy-tier reads (team mode is their home)', () => {
    for (const slug of ['contact_list', 'contact_find', 'email_list', 'email_get', 'api_key_refs']) {
      expect(isPublicReadOnlyTool({ slug, handler: { kind: 'builtin', ref: slug } })).toBe(false);
    }
  });

  it('NEVER admits non-builtin handlers, even with a listed slug', () => {
    expect(
      isPublicReadOnlyTool({
        slug: 'table_query',
        handler: { kind: 'http', url: 'https://example.com' },
      }),
    ).toBe(false);
    expect(
      isPublicReadOnlyTool({ slug: 'note_get', handler: { kind: 'recipe', steps: [] } }),
    ).toBe(false);
    expect(isPublicReadOnlyTool({ slug: 'note_get', handler: { kind: 'shell', cmd: 'ls' } })).toBe(
      false,
    );
  });

  it('the list contains no mutation-shaped slugs (nothing create/update/delete/add/set/send)', () => {
    const mutating = /(create|update|delete|add|set|send|write|upload|rename|move|commit|publish)/;
    for (const slug of PUBLIC_READONLY_TOOL_SLUGS) {
      expect(slug).not.toMatch(mutating);
    }
  });
});
