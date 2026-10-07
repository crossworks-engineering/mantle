// The pure half of login-notices.ts: reading a `login_notice` payload and
// turning a chat reply into a lock-screen line. Who is told, and with which
// words, is proven on Postgres (login-notices.db.test.ts).

import { describe, expect, it } from 'vitest';
import { chatTeaser, parseLoginNotice } from './login-notices';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('parseLoginNotice', () => {
  it('reads the three kinds the triggers send', () => {
    expect(parseLoginNotice(JSON.stringify({ kind: 'chat', loginId: A, id: B }))).toEqual({
      kind: 'chat',
      loginId: A,
      id: B,
    });
    expect(
      parseLoginNotice(JSON.stringify({ kind: 'review', loginId: A, id: B, state: 'returned' })),
    ).toEqual({ kind: 'review', loginId: A, id: B, state: 'returned' });
    expect(parseLoginNotice(JSON.stringify({ kind: 'comment', id: B }))).toEqual({
      kind: 'comment',
      id: B,
    });
  });

  it('drops anything else: bad JSON, a missing or malformed id, an unknown kind or state', () => {
    for (const payload of [
      'not json',
      'null',
      '[]',
      JSON.stringify({ kind: 'chat', loginId: A }),
      JSON.stringify({ kind: 'chat', loginId: 'x', id: B }),
      JSON.stringify({ kind: 'chat', id: B }),
      JSON.stringify({ kind: 'review', loginId: A, id: B, state: 'submitted' }),
      JSON.stringify({ kind: 'review', loginId: A, id: B }),
      JSON.stringify({ kind: 'comment', id: "1'; drop table x" }),
      JSON.stringify({ kind: 'owner', loginId: A, id: B }),
    ]) {
      expect(parseLoginNotice(payload), payload).toBeNull();
    }
  });
});

describe('chatTeaser', () => {
  it('is one clipped line', () => {
    expect(chatTeaser('  Hello\n\nthere  ')).toBe('Hello there');
    const long = chatTeaser('A'.repeat(300));
    expect(long).toHaveLength(140);
    expect(long.endsWith('…')).toBe(true);
  });

  it('shows plain words, not markdown', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(chatTeaser('## Update\n\nThe **pump** spec is _ready_.')).toBe(
      'Update The pump spec is ready.',
    );
    expect(chatTeaser('- one\n- two')).toBe('one two');
    expect(chatTeaser('See [the docs](https://example.invalid/a) now')).toBe('See the docs now');
    expect(chatTeaser('Run:\n```\npnpm verify\n```')).toBe('Run: pnpm verify');
    expect(chatTeaser('| A | B |\n|---|---|\n| 1 | 2 |')).toBe('A B 1 2');
    expect(chatTeaser(`Open [Pump spec](page:${id})`)).toBe('Open Pump spec');
  });

  it('reads only the start, fast, and a picture the cut splits leaks no alt text', () => {
    // A long run of `![` was slow before the cut (the pattern backtracks).
    const t0 = performance.now();
    expect(chatTeaser('![x'.repeat(200_000))).toBe('New message');
    expect(performance.now() - t0).toBeLessThan(2000);
    // Pictures up to the cut, then one the cut splits in its alt text.
    const pics = '![p](/api/member/files/a) '.repeat(150); // 3900 characters
    const split = `${pics}![secret alt text`.padEnd(4000, 'x') + '](/api/member/files/b)';
    expect(chatTeaser(split)).not.toContain('secret');
  });

  it('leaves pictures out whole, alt text too, kept or escaped', () => {
    expect(chatTeaser('See ![the plan](/api/member/files/abc) below')).toBe('See below');
    expect(chatTeaser('Look !\\[x](https://elsewhere.example/a.png) here')).toBe('Look here');
  });

  it('says so when the reply is a picture and nothing else', () => {
    expect(chatTeaser('![chart](/api/client/draws/abc/svg)')).toBe('New message');
    expect(chatTeaser('')).toBe('New message');
  });
});
