/**
 * P4 — behavioural data. Runs the scripted turns against the REAL assistant.
 *
 * Nothing here writes a trace, a message or a tool result: every one is a
 * by-product of a real turn. That is the whole point — a hand-authored trace
 * has the wrong shape in ways you only discover on the /traces screen, which
 * is exactly where the demo would be caught out.
 *
 * P3's extraction already produced ~1100 traces and ~6900 trace steps as a
 * side effect of summarising and fact-extracting every node. What it could
 * NOT produce is conversation: assistant_messages, tool_results, and the
 * per-turn traces that make /debug/journey worth opening. That is this file.
 *
 *   pnpm -C server/web exec tsx ../../demo/seed/turns.ts [--limit N] [--concurrency N]
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from '../../server/web/node_modules/postgres/src/index.js';
import type { Manifest, Sql } from './lib/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST = join(here, '..', 'generator', 'out', 'manifest.json');
const SERVER = process.env.DEMO_SERVER_URL ?? 'http://127.0.0.1:3902';
const DB = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:56432/postgres';
const OWNER_EMAIL = process.env.DEMO_OWNER_EMAIL ?? 'alex@harbourlabs.example.com';
const OWNER_PASSWORD = process.env.DEMO_OWNER_PASSWORD ?? 'demo-brain-not-a-real-password';

const argOf = (flag: string, dflt: number) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};
const LIMIT = argOf('--limit', Infinity);
// Re-running the whole set costs real time and real spend, so allow targeting
// the subset a phase actually needs (e.g. only the run-seeking turns once the
// conversation is already seeded).
const ONLY_RUNS = process.argv.includes('--only-runs');
// Kept low on purpose: a burst of concurrent turns is exactly the storm the
// extractor queue was built to avoid, and the provider rate-limits it.
const CONCURRENCY = argOf('--concurrency', 2);

const DAY = 86_400_000;
const SEED_TIME = Date.now();

let cookie = '';
async function login() {
  const res = await fetch(`${SERVER}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
  });
  if (!res.ok) throw new Error(`turns: login failed (${res.status})`);
  cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
}

/** Run one turn and drain its SSE stream. Returns ok/failed, never throws —
 *  one refused turn must not abandon a 40-minute run. */
async function runTurn(text: string, agentSlug: string): Promise<'ok' | 'failed'> {
  try {
    const res = await fetch(`${SERVER}/api/assistant/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text, agentSlug }),
    });
    if (!res.ok || !res.body) return 'failed';
    // The turn is only complete when the stream closes — reading to the end is
    // what makes this a real turn rather than a fire-and-forget request.
    const reader = res.body.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    return 'ok';
  } catch {
    return 'failed';
  }
}

async function main() {
  const manifest: Manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const sql = postgres(DB, { onnotice: () => {} }) as unknown as Sql;
  if (!DB.includes(':56432/')) {
    console.error('✗ refusing to run turns against a non-demo database');
    process.exit(1);
  }

  const pool = ONLY_RUNS ? manifest.turns.filter((t) => t.wantsRun) : manifest.turns;
  const turns = pool.slice(0, LIMIT === Infinity ? undefined : LIMIT);
  if (ONLY_RUNS) console.log(`  (--only-runs: ${turns.length} of ${manifest.turns.length} turns)`);
  console.log(`\ndemo turns — ${turns.length} scripted turns, concurrency ${CONCURRENCY}\n  server ${SERVER}\n`);
  await login();

  let ok = 0, failed = 0, i = 0;
  const started = Date.now();
  const worker = async () => {
    for (;;) {
      const idx = i++;
      if (idx >= turns.length) return;
      const t = turns[idx];
      const r = await runTurn(t.prompt, t.agent);
      if (r === 'ok') ok++; else failed++;
      const done = ok + failed;
      if (done % 10 === 0 || done === turns.length) {
        const rate = done / ((Date.now() - started) / 1000);
        const eta = Math.round((turns.length - done) / Math.max(rate, 0.01));
        console.log(`  ${done}/${turns.length} · ok ${ok} · failed ${failed} · ~${eta}s left`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Spread the conversation back over the timeline. Turns run now, but a
  // transcript that all happened in one afternoon reads like a script — which
  // it is, and the demo should not advertise that.
  console.log('\n· backdating the conversation');
  // Only the messages this invocation created — a subset run must not
  // renumber timestamps that a previous run already placed correctly.
  const rows = await sql`
    select id from assistant_messages where created_at >= ${new Date(SEED_TIME).toISOString()}
    order by created_at asc`;
  let moved = 0;
  for (let k = 0; k < rows.length; k++) {
    const t = turns[Math.min(Math.floor(k / 2), turns.length - 1)];
    const ts = new Date(SEED_TIME + (t?.offset ?? -1) * DAY).toISOString();
    await sql`update assistant_messages set created_at = ${ts} where id = ${rows[k].id as string}::uuid`;
    moved++;
  }

  const stat = async (t: string) => Number((await sql`select count(*)::int n from ${sql(t)}`)[0]?.n ?? 0);
  console.log(
    `\n✓ turns complete — ok ${ok}, failed ${failed}, ${moved} messages backdated\n` +
      `  assistant_messages ${await stat('assistant_messages')} · traces ${await stat('traces')} · ` +
      `trace_steps ${await stat('trace_steps')} · tool_results ${await stat('tool_results')}\n`,
  );
  await sql.end();
  if (ok === 0) process.exit(1);
}

main().catch((err) => {
  console.error('\n✗ turns failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
