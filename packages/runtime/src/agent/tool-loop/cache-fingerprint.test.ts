import { describe, expect, it } from 'vitest';
import { cacheFingerprint } from './cache-fingerprint';
import type { ChatMessage } from '../messages';

const marked = (text: string): ChatMessage => ({
  role: 'system',
  content: [{ type: 'text', text, cacheControl: { type: 'ephemeral' } }],
});
const tool = (name: string) => ({
  type: 'function' as const,
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
});

describe('cacheFingerprint', () => {
  it('hashes the tools and each marked system block, skipping unmarked ones', () => {
    const fp = cacheFingerprint(
      [
        marked('persona'),
        marked('notes'),
        { role: 'system', content: 'volatile' },
        { role: 'user', content: 'hi' },
      ],
      [tool('search')],
    );
    expect(fp.blocks).toHaveLength(2);
    expect(fp.tools).toMatch(/^[0-9a-f]{8}$/);
  });

  it('changes only the part that changed', () => {
    const a = cacheFingerprint([marked('persona'), marked('notes v1')], [tool('search')]);
    const b = cacheFingerprint([marked('persona'), marked('notes v2')], [tool('search')]);
    expect(b.tools).toBe(a.tools);
    expect(b.blocks[0]).toBe(a.blocks[0]);
    expect(b.blocks[1]).not.toBe(a.blocks[1]);
  });

  it('tool order changes the tools hash', () => {
    const a = cacheFingerprint([], [tool('a'), tool('b')]);
    const b = cacheFingerprint([], [tool('b'), tool('a')]);
    expect(a.tools).not.toBe(b.tools);
  });

  it('no tools sent: tools is null', () => {
    expect(cacheFingerprint([marked('p')], null).tools).toBeNull();
  });
});
