/**
 * The member token budget counts completion tokens only (A10 #5 fix round 1),
 * on a real, migrated Postgres: a member chat turn's trace, opened as
 * run-team-turn opens it (responder_turn, team_turn, the login stamped), with
 * provider calls made through the @mantle/voice registry the way the turn's
 * code makes them, read back by the budget's own reader (memberTokensSince).
 *
 *   - an embedding the size of a spilled 1 MB query_result (about 200 chunks,
 *     250,000 tokens) lands in the trace's embed total and does not move the
 *     budget; its cost still counts toward the trace's cost;
 *   - a chat round moves it by its tokens in + out;
 *   - a narrated status line (a chat call charged to the turn) moves it too.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run packages/runtime/src/agent/spend-budget.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

type Row = Record<string, unknown>;

describe.skipIf(!URL)('member token budget: completion tokens only', () => {
  let m: typeof import('@mantle/db');
  let tracing: typeof import('@mantle/tracing');
  let voice: typeof import('@mantle/voice');
  let ledger: typeof import('@mantle/content');
  let admin: (strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>;
  const tag = `spend-budget-${randomUUID().slice(0, 8)}`;
  const anchor = randomUUID();
  const member = randomUUID();
  const since = new Date(Date.now() - 60 * 60 * 1000);
  /** A provider id no real adapter uses. */
  const P = `spend-budget-fake-${tag}` as never;
  const CHUNKS = 200;
  const TOKENS_PER_CHUNK = 1250;

  beforeAll(async () => {
    process.env.DATABASE_URL = URL;
    m = await import('@mantle/db');
    tracing = await import('@mantle/tracing');
    voice = await import('@mantle/voice');
    ledger = await import('@mantle/content');
    admin = (m.systemDb as unknown as { $client: typeof admin }).$client;
    await admin`insert into auth.users (id, email, password_hash, role) values
      (${anchor}, ${`anchor-${tag}@example.invalid`}, 'x', 'admin'),
      (${member}, ${`member-${tag}@example.invalid`}, 'x', 'member')`;
    voice.registerEmbeddingAdapter({
      providerId: P,
      adapterName: 'spend-budget-fake-embedding',
      embed: async (req) => ({
        vectors: req.input.map(() => [0.1]),
        model: req.model,
        tokensIn: req.input.length * TOKENS_PER_CHUNK,
      }),
    });
    voice.registerChatAdapter({
      providerId: P,
      adapterName: 'spend-budget-fake-chat',
      chat: async (o) => ({ text: 'ok', model: o.model, tokensIn: 1000, tokensOut: 200 }),
    });
  }, 60_000);

  afterAll(async () => {
    if (!admin) return;
    await admin`delete from traces where owner_id = ${anchor}`;
    await admin`delete from auth.users where id in (${member}, ${anchor})`;
    await m.closeDb();
  });

  /** One member chat turn, as run-team-turn opens its trace. */
  const teamTurn = (fn: () => Promise<unknown>) =>
    tracing.startTrace(
      {
        ownerId: anchor,
        kind: 'responder_turn',
        subjectKind: 'team_turn',
        loginId: member,
        data: { login_id: member },
      },
      () => tracing.step({ name: 'tool: query_result', kind: 'compute' }, fn),
    );
  const used = () => ledger.memberTokensSince(anchor, member, since);
  /** The trace's close write and a late charge's increment are sent after
   *  the turn returns, unawaited (recording never holds a result back), so
   *  a fixed pause raced them on a busy box (round 10: 1 in 3 runs with the
   *  runtime role off). Wait, bounded, for what each assertion reads. */
  const closed = async (n: number) =>
    expect
      .poll(
        async () =>
          Number(
            (
              await admin`select count(*)::int as n from traces
                where owner_id = ${anchor} and finished_at is not null`
            )[0]!.n,
          ),
        { timeout: 15_000, interval: 50 },
      )
      .toBe(n);

  it('an embed of a spilled 1 MB result does not move it; a chat round does', async () => {
    expect(await used()).toBe(0);

    await teamTurn(() =>
      voice.getEmbeddingAdapter(P)!.embed({
        apiKey: 'k',
        model: 'openai/text-embedding-3-small',
        input: Array.from({ length: CHUNKS }, (_, i) => `chunk ${i}`),
      }),
    );
    await closed(1);
    const [embedTrace] = await admin`select tokens_in, tokens_out, tokens_embed, cost_micro_usd
      from traces where owner_id = ${anchor} order by started_at desc limit 1`;
    expect(embedTrace).toMatchObject({ tokens_in: 0, tokens_out: 0, tokens_embed: 250_000 });
    // 250,000 * $0.02 per million = $0.005: the cost counts (run budgets).
    expect(Number(embedTrace!.cost_micro_usd)).toBe(5000);
    expect(await used()).toBe(0);

    await teamTurn(() =>
      voice.getChatAdapter(P)!.chat({
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      }),
    );
    await closed(2);
    expect(await used()).toBe(1200);
  });

  it('a narrated status line (chat charged to the turn) counts: it is chat', async () => {
    const before = await used();
    let late: Promise<unknown> = Promise.resolve();
    await teamTurn(async () => {
      late = tracing.chargeTo(tracing.spendTarget(), async () => {
        await new Promise((r) => setTimeout(r, 20));
        return voice.getChatAdapter(P)!.chat({
          apiKey: 'k',
          model: 'm',
          messages: [{ role: 'user', content: 'Searching your brain…' }],
        });
      });
    });
    await late;
    await closed(3);
    // The late charge lands after the close, by an increment.
    await expect
      .poll(async () => (await used()) - before, { timeout: 15_000, interval: 50 })
      .toBe(1200);
  });
});
