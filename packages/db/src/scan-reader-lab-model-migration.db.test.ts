/**
 * Migration scan_reader_lab_model, on a real migrated Postgres: a Scan
 * reader route still on the old shipped default moves to the lab model, a
 * model picked by hand is kept, the backup route moves on its own, another
 * kind is never touched; the pool's template row moves, a row edited by
 * hand (its note, or only its name) is kept, and where the new row is
 * there already the old one goes; a second run changes nothing. Everything
 * runs inside ONE transaction that is rolled back.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/db/src/scan-reader-lab-model-migration.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superuserClient } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const OLD = 'meta-llama/llama-3.1-8b-instruct';
const NEW = 'openai/gpt-6-luna';

type Row = Record<string, unknown>;
type Sql = ((strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>) &
  ((list: readonly string[]) => unknown) & {
    unsafe: (q: string) => Promise<Row[]>;
    begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
  };

function migrationStatements(): string[] {
  const dir = join(__dirname, '..', 'migrations');
  const name = readdirSync(dir).find((f) => f.endsWith('_scan_reader_lab_model.sql'))!;
  return readFileSync(join(dir, name), 'utf8').split('--> statement-breakpoint');
}

class Rollback extends Error {}

async function inRollback(admin: Sql, fn: (tx: Sql) => Promise<void>): Promise<void> {
  try {
    await admin.begin(async (tx) => {
      await tx`select set_config('mantle.actor', 'system:migration', true),
                      set_config('mantle.write_mode', 'rw', true)`;
      await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

async function migrate(tx: Sql): Promise<void> {
  for (const stmt of migrationStatements()) await tx.unsafe(stmt);
}

describe.skipIf(!URL)('migration scan_reader_lab_model', () => {
  let admin: Sql;

  beforeAll(() => {
    admin = superuserClient(URL!) as unknown as Sql;
  });
  afterAll(async () => {
    await (admin as unknown as { end: () => Promise<void> }).end();
  });

  it('moves only the pool row still the shipped template', async () => {
    await inRollback(admin, async (tx) => {
      const OLD_ROUTES = JSON.stringify([{ provider: 'openrouter', model: OLD }]);
      const SHIPPED = 'the shipped default: the text model behind the mistral-ocr PDF parser';
      const owners = {
        plain: randomUUID(),
        edited: randomUUID(),
        renamed: randomUUID(),
        both: randomUUID(),
      };
      for (const id of Object.values(owners)) {
        await tx`insert into auth.users (id, email, password_hash, role)
                 values (${id}, ${`${id.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
      }
      const add = async (owner: string, name: string, routes: string, note: string) => {
        await tx`insert into curated_models (owner_id, pool, position, name, vendor, routes, note)
                 values (${owner}, 'scan_reader', 0, ${name}, 'Meta', ${routes}::text::jsonb, ${note})`;
      };
      await add(owners.plain, 'Meta: Llama 3.1 8B Instruct', OLD_ROUTES, SHIPPED);
      await add(owners.edited, 'Meta: Llama 3.1 8B Instruct', OLD_ROUTES, 'my own pick');
      // Renamed by hand, routes and note left alone: kept.
      await add(owners.renamed, 'Llama, our cheap one', OLD_ROUTES, SHIPPED);
      await add(owners.both, 'Meta: Llama 3.1 8B Instruct', OLD_ROUTES, SHIPPED);
      await add(
        owners.both,
        'OpenAI: GPT-6 Luna',
        JSON.stringify([{ provider: 'openrouter', model: NEW }]),
        'added by hand',
      );

      await migrate(tx);

      const rows = async (owner: string) =>
        await tx`select name, vendor, routes, note from curated_models
                 where owner_id = ${owner} order by name`;
      const plain = await rows(owners.plain);
      expect(plain).toHaveLength(1);
      expect(plain[0]).toMatchObject({
        name: 'OpenAI: GPT-6 Luna',
        vendor: 'OpenAI',
        routes: [{ provider: 'openrouter', model: NEW }],
      });
      expect(String(plain[0]!['note'])).toMatch(/^the shipped default: the chat model/);
      expect(await rows(owners.edited)).toEqual([
        {
          name: 'Meta: Llama 3.1 8B Instruct',
          vendor: 'Meta',
          routes: [{ provider: 'openrouter', model: OLD }],
          note: 'my own pick',
        },
      ]);
      expect(await rows(owners.renamed)).toEqual([
        {
          name: 'Llama, our cheap one',
          vendor: 'Meta',
          routes: [{ provider: 'openrouter', model: OLD }],
          note: SHIPPED,
        },
      ]);
      expect(await rows(owners.both)).toEqual([
        {
          name: 'OpenAI: GPT-6 Luna',
          vendor: 'Meta',
          routes: [{ provider: 'openrouter', model: NEW }],
          note: 'added by hand',
        },
      ]);

      const all = async () =>
        await tx`select owner_id, name, routes, note, updated_at from curated_models
                 where owner_id in ${tx(Object.values(owners))} order by owner_id, name`;
      const before = await all();
      await migrate(tx);
      expect(await all()).toEqual(before);
    });
  });

  it('moves only a route still on the old default', async () => {
    await inRollback(admin, async (tx) => {
      const owner = randomUUID();
      await tx`insert into auth.users (id, email, password_hash, role)
               values (${owner}, ${`${owner.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
      const add = async (
        slug: string,
        kind: string,
        model: string,
        backup: string | null = null,
      ): Promise<void> => {
        await tx`insert into ai_workers (owner_id, slug, name, kind, provider, model,
                                         backup_provider, backup_model)
                 values (${owner}, ${slug}, ${slug}, ${kind}::ai_worker_kind, 'openrouter',
                         ${model}, ${backup ? 'openrouter' : null}, ${backup})`;
      };
      await add('scan-default', 'scan_reader', OLD, OLD);
      await add('scan-by-hand', 'scan_reader', 'google/gemini-3.8-flash', OLD);
      await add('summarizer-llama', 'summarizer', OLD);

      await migrate(tx);

      const read = async (slug: string) =>
        (
          await tx`select model, backup_model from ai_workers
                   where owner_id = ${owner} and slug = ${slug}`
        )[0];
      expect(await read('scan-default')).toEqual({ model: NEW, backup_model: NEW });
      expect(await read('scan-by-hand')).toEqual({
        model: 'google/gemini-3.8-flash',
        backup_model: NEW,
      });
      expect(await read('summarizer-llama')).toEqual({ model: OLD, backup_model: null });

      const before = await tx`select slug, model, backup_model, updated_at from ai_workers
                              where owner_id = ${owner} order by slug`;
      await migrate(tx);
      expect(
        await tx`select slug, model, backup_model, updated_at from ai_workers
                 where owner_id = ${owner} order by slug`,
      ).toEqual(before);
    });
  });
});
