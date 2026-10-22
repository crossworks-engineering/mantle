/**
 * The ONE narrow area-route sweep (plan v3.2 S7b part b2): every writing
 * area row of the route table (narrow-area-sweep.entries.ts, one entry per
 * row, checked against the table by narrow-area-sweep.entries.test.ts)
 * driven through the real app (createApp) as an Admin user with a signed
 * session cookie, twice: on a fresh brain with the narrow switch on, then
 * on a second fresh brain with the same fixture and the switch off. Every
 * row must answer the same both ways (its status and its body, less ids,
 * stamps and minted tokens), and on the narrow pass no statement may be
 * refused by the narrow role (takeNarrowDenials, per row).
 *
 * The fixture holds rows at the sample id the paths carry (an assistant, a
 * tool group, a skill, a member login), so the PATCH, DELETE and action
 * rows reach their writes, and a documentation collection on a real
 * markdown file: made (the docs-item insert through the structure
 * definer), then the file edited and the collection re-read (its update).
 * No network (fetch throws), no updater, no sandbox daemon: those rows
 * answer their own refusal, the same both ways.
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm vitest run server/web/server/narrow-area-sweep.db.test.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NARROW_SWEEP_ENTRIES, writingAreaRows } from './narrow-area-sweep.entries';
import { SAMPLE_ID } from './a10-body-sweep.samples';

const URL = process.env.MANTLE_TEST_DATABASE_URL;

vi.mock('@mantle/crypto', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  seal: vi.fn(() => ({ ciphertext: Buffer.from('sealed'), keyVersion: 1 })),
  open: vi.fn(() => JSON.stringify({ note: 'n', fields: [] })),
}));

vi.mock('@mantle/voice', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    getEmbeddingAdapter: () => ({
      embed: async ({ input }: { input: unknown[] }) => ({
        vectors: input.map(() => Array.from({ length: 768 }, () => 0.01)),
      }),
    }),
  };
});

/** The a10 body sweep's valid body per row (made from each route's schema). */
const bodies = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '__snapshots__', 'a10-body-sweep.bodies.json'),
    'utf8',
  ),
) as Record<string, unknown>;

const OWNER = '22222222-2222-4222-8222-222222222222';

/** An answer less what is fresh each run: ids, stamps, minted tokens. */
function normalize(text: string): string {
  return text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'U')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, 'T')
    .replace(/\b\d{10,}\b/g, 'N')
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, 'K')
    .replace(/\/tmp\/[^"\s]*/g, 'P')
    .slice(0, 400);
}

describe.skipIf(!URL)(
  'the narrow area-route sweep: every writing area row, switch on and off',
  () => {
    type Ts = typeof import('@mantle/db/test-support');
    let ts: Ts;
    let rr: typeof import('@mantle/db/runtime-role');
    let m: typeof import('@mantle/db');
    let app: { request: (path: string, init: RequestInit) => Response | Promise<Response> };
    let rows: { key: string }[] = [];
    let dir = '';
    const realFetch = globalThis.fetch;
    const answers: Record<'on' | 'off', Map<string, string>> = { on: new Map(), off: new Map() };
    const denials = new Map<string, unknown[]>();
    const docs: Record<string, { made: number; updated: number }> = {};

    beforeAll(async () => {
      ts = await import('@mantle/db/test-support');
      rr = await import('@mantle/db/runtime-role');
      dir = mkdtempSync(join(tmpdir(), 'narrow-sweep-'));
      process.env.MANTLE_MASTER_KEY ??= 'mantle-viewer-test-key';
      process.env.SESSION_SECRET = 'narrow-area-sweep-secret-at-least-32-characters';
      process.env.MANTLE_DOCS_ROOT = join(dir, 'docs');
      process.env.MANTLE_BACKUP_DIR = join(dir, 'backups');
      process.env.MANTLE_TAILSCALE_SOCK = join(dir, 'tailscaled.sock');
      globalThis.fetch = (async () => {
        throw new Error('sweep: no network');
      }) as typeof fetch;
      const { routeManifest } = await import('./route-manifest.gen');
      const { buildRoutePolicy } = await import('../lib/auth/route-policy');
      rows = writingAreaRows(buildRoutePolicy(routeManifest));
      for (const pass of ['on', 'off'] as const) await runPass(pass);
    }, 900_000);

    afterAll(async () => {
      globalThis.fetch = realFetch;
      rr?.setNarrowSystemForTests(null);
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    async function runPass(pass: 'on' | 'off'): Promise<void> {
      const scratch = await ts.createMigratedScratchDatabase(URL!);
      const su = postgres(scratch.url, { max: 1, prepare: false, onnotice: () => {} });
      try {
        process.env.DATABASE_URL = scratch.url;
        rr.setNarrowSystemForTests(pass === 'on');
        m = await import('@mantle/db');
        await su`insert into auth.users (id, email, password_hash, is_owner, role, display_name)
               values (${OWNER}, 'sweep-owner@example.test', 'x', true, 'admin', 'Sweep Owner')`;
        await su`insert into spaces (id, kind, login_id) values (${OWNER}, 'brain', ${OWNER})
               on conflict (id) do nothing`;
        await ts.runWorkspacesSwitch(scratch.url);
        await su`insert into profiles (user_id) values (${OWNER}) on conflict do nothing`;
        // The rows the sample id names: a member login, an assistant, a tool
        // group and a skill of this brain.
        await su`insert into auth.users (id, email, password_hash, role, display_name)
               values (${SAMPLE_ID}, 'sweep-member@example.test', 'x', 'member', 'Sweep Member')`;
        await su`insert into tool_groups (id, owner_id, slug, name, tool_slugs)
               values (${SAMPLE_ID}, ${OWNER}, 'sweep-group', 'Sweep group', '{search}')`;
        await su`insert into agents (id, owner_id, slug, name, role, model, system_prompt, tool_group_slugs)
               values (${SAMPLE_ID}, ${OWNER}, 'sweep-agent', 'Sweep agent', 'responder', 'm', 'p', '{sweep-group}')`;
        await su`insert into skills (id, owner_id, slug, name, body)
               values (${SAMPLE_ID}, ${OWNER}, 'sweep-skill', 'Sweep skill', 'b')
               on conflict do nothing`.catch(() => undefined);
        const col = join(dir, 'docs', `sweep-${pass}`);
        mkdirSync(col, { recursive: true });
        writeFileSync(join(col, 'a.md'), '# Sweep guide\n\nThe first text.\n');
        const tokens = await import('../lib/auth/tokens');
        const cookie = `mantle_session=${tokens.buildSessionCookie(OWNER).value}`;
        const { createApp } = await import('./app');
        app = await createApp();
        const send = async (method: string, path: string, body: unknown) => {
          const res = await app.request(path, {
            method,
            headers: { 'content-type': 'application/json', cookie },
            ...(body === null || body === undefined ? {} : { body: JSON.stringify(body) }),
          });
          return { status: res.status, text: await res.text().catch(() => '') };
        };
        const sample = bodies;
        for (const row of rows) {
          const entry = NARROW_SWEEP_ENTRIES[row.key];
          if (!entry || 'skip' in entry) continue;
          const [method, pattern] = row.key.split(' ') as [string, string];
          const path =
            entry.path ?? pattern.replace(/:[A-Za-z0-9_]+\??/g, SAMPLE_ID).replace(/\*$/, 'a/b');
          const body = 'body' in entry ? entry.body : method === 'GET' ? null : sample[row.key];
          const r = await send(method, path, body);
          answers[pass].set(row.key, `${r.status} ${normalize(r.text)}`);
          if (pass === 'on') denials.set(row.key, ts.takeNarrowDenials());
        }
        // LOW-4: a documentation item made from a real markdown file, then
        // the file edited and the collection read again (its update).
        const docCount = async (text: string) =>
          (
            await su<{ n: number }[]>`
          select count(*)::int as n from nodes where owner_id = ${OWNER}
             and type = 'documentation' and data::text like ${`%${text}%`}`
          )[0]!.n;
        const made = await send('POST', '/api/docs/collections', {
          label: `Sweep ${pass}`,
          key: `sweep-${pass}`,
          rootPath: col,
          brainDepth: 'retrieval',
        });
        expect(made.status, made.text).toBe(200);
        const [c] = await su<{ id: string }[]>`
        select id::text as id from doc_collections where key = ${`sweep-${pass}`}`;
        writeFileSync(join(col, 'a.md'), '# Sweep guide\n\nThe second text.\n');
        await send('PATCH', `/api/docs/collections/${c!.id}`, { enabled: false });
        await send('PATCH', `/api/docs/collections/${c!.id}`, { enabled: true });
        docs[pass] = { made: made.status, updated: await docCount('second text') };
        if (pass === 'on') denials.set('docs-item', ts.takeNarrowDenials());
      } finally {
        await m?.closeDb();
        await su.end();
        await scratch.drop();
      }
    }

    it('drives every writing area row but those the table says why', () => {
      const driven = rows.filter((r) => !('skip' in (NARROW_SWEEP_ENTRIES[r.key] ?? {})));
      expect(answers.on.size).toBe(driven.length);
      expect(answers.off.size).toBe(driven.length);
    });

    it('no row is refused by the narrow role', () => {
      const refused = [...denials].filter(([, d]) => d.length > 0);
      expect(refused).toEqual([]);
    });

    it('every row answers the same with the switch on and off', () => {
      const differ = [...answers.on]
        .filter(([k, a]) => answers.off.get(k) !== a)
        .map(([k, a]) => ({ row: k, on: a, off: answers.off.get(k) }));
      expect(differ).toEqual([]);
    });

    it('no row answers 500 on the narrow pass', () => {
      const failed = [...answers.on].filter(([, a]) => a.startsWith('500 '));
      expect(failed).toEqual([]);
    });

    it('a documentation item from a real markdown file: made and updated, the same both ways', () => {
      expect(docs.on).toEqual({ made: 200, updated: 1 });
      expect(docs.off).toEqual(docs.on);
    });

    it('reports what each row answered (the handover reads the status counts)', () => {
      const counts: Record<string, number> = {};
      for (const a of answers.on.values()) {
        const s = a.slice(0, 1) + 'xx';
        counts[s] = (counts[s] ?? 0) + 1;
      }
      console.log(`narrow sweep: ${answers.on.size} rows driven; on-pass statuses`, counts);
      expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(answers.on.size);
    });
  },
);
