/**
 * The narrow route's denial notes, no database: the text check's refusal is
 * a noted denial (text:<what>) and thrown, once per error; the one call
 * pattern the measurement and the static scan read; and a narrow denial is
 * one miss row per actor and table an hour.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { noteActorMiss, setActorMissLogger, takeNarrowDenials, type ActorMiss } from './actor';
import { checkSendable, noteNarrowDenial } from './gateway/narrow-denial';
import { CALLED_FN, NarrowRouteRefusedError } from './gateway/narrow-sendable';

describe('the narrow route text check', () => {
  it('a refusal is a noted denial (text:<what>) and thrown, once per error', () => {
    takeNarrowDenials();
    let thrown: unknown = null;
    try {
      checkSendable('do $$ begin perform 1; end $$', false);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NarrowRouteRefusedError);
    // The same error met again (a savepoint's, the transaction's, or
    // drizzle's wrapper whose cause it is) is not noted twice.
    noteNarrowDenial(thrown);
    noteNarrowDenial(new Error('Failed query', { cause: thrown }));
    expect(takeNarrowDenials().map((d) => d.what)).toEqual(['text:a-do-block | ?']);
    // A tagged template's text is checked too.
    expect(() => checkSendable('set role postgres', true)).toThrow(NarrowRouteRefusedError);
    expect(takeNarrowDenials().map((d) => d.what)).toEqual(['text:a-role-change | ?']);
    checkSendable('select 1', false);
    expect(takeNarrowDenials()).toEqual([]);
    // A wrapper noted before its cause: the text refusal read on the chain.
    noteNarrowDenial(
      new Error('Failed query', { cause: new NarrowRouteRefusedError('a DO block') }),
    );
    expect(takeNarrowDenials().map((d) => d.what)).toEqual(['text:a-do-block | ?']);
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

describe('a narrow denial is one row per actor and table an hour', () => {
  const nodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = nodeEnv;
    setActorMissLogger(() => {});
    vi.restoreAllMocks();
  });

  it('a second reason on the same table is a row of its own; another check keeps its key', () => {
    const rows: ActorMiss[] = [];
    setActorMissLogger((m) => rows.push(m));
    process.env.NODE_ENV = 'production';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const write = (check: string, actor: string) =>
      noteActorMiss({ source: 'sql', check, actor, detail: 'nodes-dedupe-cell SELECT' });
    write('narrow-denied', 'system:admin-area');
    write('narrow-denied', 'system:admin-area');
    write('narrow-denied', 'system:http:login-self');
    write('no-actor-dedupe-cell', 'a');
    write('no-actor-dedupe-cell', 'b');
    expect(rows.map((r) => `${r.check} ${r.actor}`)).toEqual([
      'narrow-denied system:admin-area',
      'narrow-denied system:http:login-self',
      'no-actor-dedupe-cell a',
    ]);
  });
});
