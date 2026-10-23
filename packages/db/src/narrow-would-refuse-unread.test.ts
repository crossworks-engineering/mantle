/**
 * The would-refuse count's reading of calls when the catalog cannot be
 * read: every call the statement makes is counted as unread (never as
 * nothing refused), and the failed load is not kept.
 */
import { describe, expect, it } from 'vitest';
import { takeNarrowWrites } from './actor';
import {
  CALLED_FN,
  noteWouldRefuseCalls,
  noteWouldRefuseStatement,
  wouldRefuseTx,
} from './gateway/narrow-would-refuse';

describe('the would-refuse call reading, catalog unread', () => {
  it('counts each called function as unread when the catalog load fails, and tries again next time', async () => {
    takeNarrowWrites();
    let loads = 0;
    const failing = {
      unsafe: () => {
        loads++;
        return Promise.reject(Object.assign(new Error('connection lost'), { code: '08006' }));
      },
    } as unknown as Parameters<typeof noteWouldRefuseCalls>[0];
    noteWouldRefuseCalls(failing, 'select mantle_one($1), public.mantle_two($2)');
    await new Promise((r) => setTimeout(r, 10));
    const first = takeNarrowWrites().map((w) => `${w.check} ${w.detail}`);
    expect(first.sort()).toEqual([
      'narrow-would-refuse fn:mantle_one UNREAD',
      'narrow-would-refuse fn:mantle_two UNREAD',
    ]);
    // A statement with no mantle_ call is not read at all.
    noteWouldRefuseCalls(failing, 'select 1');
    await new Promise((r) => setTimeout(r, 10));
    expect(takeNarrowWrites()).toEqual([]);
    expect(loads).toBe(1);
    // The failure was not kept: the next statement loads again.
    noteWouldRefuseCalls(failing, 'select mantle_one($1)');
    await new Promise((r) => setTimeout(r, 10));
    expect(loads).toBe(2);
    expect(takeNarrowWrites().map((w) => w.detail)).toEqual(['fn:mantle_one UNREAD']);
  });

  it('counts the text check the narrow route runs first: each refused text once, as text:<what>, its calls still read', async () => {
    takeNarrowWrites();
    const none = { unsafe: () => Promise.resolve([]) } as unknown as Parameters<
      typeof noteWouldRefuseStatement
    >[0];
    const refused: [string, string][] = [
      ['do $$ begin perform 1; end $$', 'text:a-do-block'],
      ['set role postgres', 'text:a-role-change'],
      ['commit', 'text:a-transaction-control-statement'],
      [
        "select set_config('search_path', 'x', false)",
        'text:a-set-config-other-than-a-local-setting-it-may-s',
      ],
      ['vacuum public.nodes', 'text:a-statement-outside-a-transaction'],
    ];
    for (const [q] of refused) noteWouldRefuseStatement(none, q);
    // A plain read or row write is sendable: nothing counted.
    noteWouldRefuseStatement(none, 'select 1');
    noteWouldRefuseStatement(none, 'update public.nodes set title = $1 where id = $2');
    await new Promise((r) => setTimeout(r, 10));
    const got = takeNarrowWrites().map((w) => `${w.check} ${w.detail}`);
    expect(got).toEqual(refused.map(([, why]) => `narrow-would-refuse ${why} TEXT`));
  });

  it('reads a tagged template inside a would-narrow transaction (the text check and its calls)', async () => {
    takeNarrowWrites();
    const base = {
      unsafe: () => Promise.resolve([{ name: 'mantle_denied', ok: false }]),
    } as unknown as Parameters<typeof wouldRefuseTx>[1];
    const sent: string[] = [];
    const tx = Object.assign((strings: TemplateStringsArray) => sent.push(strings.join('$1')), {
      unsafe: (q: string) => sent.push(q),
    }) as unknown as Parameters<typeof wouldRefuseTx>[0];
    const t = wouldRefuseTx(tx, base) as unknown as (
      s: TemplateStringsArray,
      ...v: unknown[]
    ) => unknown;
    t`do $$ begin perform 1; end $$`;
    t`select public.mantle_denied(${1})`;
    await new Promise((r) => setTimeout(r, 10));
    expect(sent).toHaveLength(2);
    const got = takeNarrowWrites().map((w) => w.detail);
    expect(got).toContain('text:a-do-block TEXT');
    expect(got).toContain('fn:mantle_denied EXECUTE');
  });

  it('reads public.mantle_* and bare mantle_* calls only (one call pattern)', () => {
    const names = (q: string) => [...q.matchAll(CALLED_FN)].map((m) => m[1]);
    expect(names('select "public"."mantle_a"(1), public.mantle_b(2), mantle_c (3)')).toEqual([
      'mantle_a',
      'mantle_b',
      'mantle_c',
    ]);
    expect(names('select other.mantle_d(1), other."mantle_e"(2), x_mantle_f(3)')).toEqual([]);
  });
});
