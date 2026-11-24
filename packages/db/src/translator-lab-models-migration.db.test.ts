/**
 * Migration translator_lab_models, on a real migrated Postgres: a
 * Translator's fallback_model and high_model still on the old shipped
 * Mistral ids move to the lab models, each key on its own; a model picked by
 * hand is kept, the other params keys stay, another kind is never touched;
 * the pool's two template rows move, a row edited by hand (its note, or only
 * its name) is kept, and where the new row is there already the old one
 * goes; a second run changes nothing. Everything runs inside ONE
 * transaction that is rolled back.
 *
 *   MANTLE_TEST_DATABASE_URL=postgres://… pnpm test packages/db/src/translator-lab-models-migration.db.test.ts
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superuserClient } from './test-support';

const URL = process.env.MANTLE_TEST_DATABASE_URL;
const OLD_FALLBACK = 'mistralai/mistral-small-2603';
const OLD_HIGH = 'mistralai/mistral-medium-3-5';
const NEW_FALLBACK = 'openai/gpt-6-luna';
const NEW_HIGH = 'anthropic/claude-sonnet-5.5';

type Row = Record<string, unknown>;
type Sql = ((strings: TemplateStringsArray, ...v: unknown[]) => Promise<Row[]>) &
  ((list: readonly string[]) => unknown) & {
    unsafe: (q: string) => Promise<Row[]>;
    begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
  };

function migrationStatements(): string[] {
  const dir = join(__dirname, '..', 'migrations');
  const name = readdirSync(dir).find((f) => f.endsWith('_translator_lab_models.sql'))!;
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

const routesOf = (model: string) => JSON.stringify([{ provider: 'openrouter', model }]);

describe.skipIf(!URL)('migration translator_lab_models', () => {
  let admin: Sql;

  beforeAll(() => {
    admin = superuserClient(URL!) as unknown as Sql;
  });
  afterAll(async () => {
    await (admin as unknown as { end: () => Promise<void> }).end();
  });

  async function addOwner(tx: Sql): Promise<string> {
    const id = randomUUID();
    await tx`insert into auth.users (id, email, password_hash, role)
             values (${id}, ${`${id.slice(0, 8)}@example.invalid`}, 'x', 'admin')`;
    return id;
  }

  it('moves only the pool rows still the shipped template', async () => {
    await inRollback(admin, async (tx) => {
      const SHIPPED_FALLBACK =
        'the shipped fallback: takes a part only when the primary fails it; 262k context';
      const SHIPPED_HIGH =
        "the shipped high model: quality 'high' only, for terminology or style work";
      const owners = {
        plain: await addOwner(tx),
        edited: await addOwner(tx),
        renamed: await addOwner(tx),
        both: await addOwner(tx),
      };
      const add = async (owner: string, pos: number, name: string, model: string, note: string) => {
        await tx`insert into curated_models (owner_id, pool, position, name, vendor, routes, note)
                 values (${owner}, 'translator', ${pos}, ${name}, 'Mistral',
                         ${routesOf(model)}::text::jsonb, ${note})`;
      };
      const SMALL = 'Mistral: Mistral Small 2603';
      const MEDIUM = 'Mistral: Mistral Medium 3.5';
      await add(owners.plain, 1, SMALL, OLD_FALLBACK, SHIPPED_FALLBACK);
      await add(owners.plain, 2, MEDIUM, OLD_HIGH, SHIPPED_HIGH);
      await add(owners.edited, 1, SMALL, OLD_FALLBACK, 'my own pick');
      await add(owners.edited, 2, MEDIUM, OLD_HIGH, 'our style model');
      // Renamed by hand, routes and note left alone: kept.
      await add(owners.renamed, 1, 'Small, our cheap one', OLD_FALLBACK, SHIPPED_FALLBACK);
      await add(owners.renamed, 2, 'Medium, for contracts', OLD_HIGH, SHIPPED_HIGH);
      await add(owners.both, 1, SMALL, OLD_FALLBACK, SHIPPED_FALLBACK);
      await add(owners.both, 2, MEDIUM, OLD_HIGH, SHIPPED_HIGH);
      await add(owners.both, 3, 'OpenAI: GPT-6 Luna', NEW_FALLBACK, 'added by hand');
      await add(owners.both, 4, 'Anthropic: Claude Sonnet 5.5', NEW_HIGH, 'added by hand');

      await migrate(tx);

      const rows = async (owner: string) =>
        await tx`select name, vendor, routes, note from curated_models
                 where owner_id = ${owner} order by position`;
      const plain = await rows(owners.plain);
      expect(plain).toMatchObject([
        {
          name: 'OpenAI: GPT-6 Luna',
          vendor: 'OpenAI',
          routes: [{ provider: 'openrouter', model: NEW_FALLBACK }],
        },
        {
          name: 'Anthropic: Claude Sonnet 5.5',
          vendor: 'Anthropic',
          routes: [{ provider: 'openrouter', model: NEW_HIGH }],
        },
      ]);
      expect(String(plain[0]!['note'])).toMatch(/^the shipped fallback: .*closed lab model/);
      expect(String(plain[1]!['note'])).toMatch(/^the shipped high model: .*closed lab model/);
      expect(await rows(owners.edited)).toEqual([
        {
          name: SMALL,
          vendor: 'Mistral',
          routes: [{ provider: 'openrouter', model: OLD_FALLBACK }],
          note: 'my own pick',
        },
        {
          name: MEDIUM,
          vendor: 'Mistral',
          routes: [{ provider: 'openrouter', model: OLD_HIGH }],
          note: 'our style model',
        },
      ]);
      expect(await rows(owners.renamed)).toEqual([
        {
          name: 'Small, our cheap one',
          vendor: 'Mistral',
          routes: [{ provider: 'openrouter', model: OLD_FALLBACK }],
          note: SHIPPED_FALLBACK,
        },
        {
          name: 'Medium, for contracts',
          vendor: 'Mistral',
          routes: [{ provider: 'openrouter', model: OLD_HIGH }],
          note: SHIPPED_HIGH,
        },
      ]);
      expect(await rows(owners.both)).toEqual([
        {
          name: 'OpenAI: GPT-6 Luna',
          vendor: 'Mistral',
          routes: [{ provider: 'openrouter', model: NEW_FALLBACK }],
          note: 'added by hand',
        },
        {
          name: 'Anthropic: Claude Sonnet 5.5',
          vendor: 'Mistral',
          routes: [{ provider: 'openrouter', model: NEW_HIGH }],
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

  it('moves only a params model still on the old default, each key on its own', async () => {
    await inRollback(admin, async (tx) => {
      const add = async (owner: string, kind: string, params: Record<string, unknown>) => {
        await tx`insert into ai_workers (owner_id, slug, name, kind, provider, model, params)
                 values (${owner}, ${kind}, ${kind}, ${kind}::ai_worker_kind, 'openrouter',
                         'google/gemini-3.1-flash-lite', ${JSON.stringify(params)}::text::jsonb)`;
      };
      const owners = {
        shipped: await addOwner(tx),
        byHand: await addOwner(tx),
        cleared: await addOwner(tx),
        other: await addOwner(tx),
      };
      await add(owners.shipped, 'translator', {
        fallback_model: OLD_FALLBACK,
        high_model: OLD_HIGH,
        part_tokens: 4000,
      });
      // The fallback picked by hand, the high model still shipped.
      await add(owners.byHand, 'translator', {
        fallback_model: 'google/gemini-3.8-flash',
        high_model: OLD_HIGH,
      });
      // The high model cleared by hand: no key is added.
      await add(owners.cleared, 'translator', { fallback_model: OLD_FALLBACK });
      await add(owners.other, 'summarizer', { fallback_model: OLD_FALLBACK, high_model: OLD_HIGH });

      await migrate(tx);

      const read = async (owner: string) =>
        (await tx`select params from ai_workers where owner_id = ${owner}`)[0]!['params'];
      expect(await read(owners.shipped)).toEqual({
        fallback_model: NEW_FALLBACK,
        high_model: NEW_HIGH,
        part_tokens: 4000,
      });
      expect(await read(owners.byHand)).toEqual({
        fallback_model: 'google/gemini-3.8-flash',
        high_model: NEW_HIGH,
      });
      expect(await read(owners.cleared)).toEqual({ fallback_model: NEW_FALLBACK });
      expect(await read(owners.other)).toEqual({
        fallback_model: OLD_FALLBACK,
        high_model: OLD_HIGH,
      });

      const all = async () =>
        await tx`select owner_id, params, updated_at from ai_workers
                 where owner_id in ${tx(Object.values(owners))} order by owner_id`;
      const before = await all();
      await migrate(tx);
      expect(await all()).toEqual(before);
    });
  });
});
