/**
 * The narrow counts' epoch (migrator-steps.ts): the version
 * migrate writes as the epoch row's detail, read from the root
 * package.json; nothing but a plain version is ever written, and no
 * version writes no row. The database double records each statement.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NARROW_EPOCH_CHECK,
  ensureNarrowEpoch,
  readReleaseVersion,
  releaseVersionOf,
} from './migrator-steps';

const ROOT = join(__dirname, '..', '..', '..');

describe('the narrow counts` epoch', () => {
  it('its check name starts with narrow-, so the reaper keeps it', () => {
    expect(NARROW_EPOCH_CHECK).toBe('narrow-epoch');
    expect(NARROW_EPOCH_CHECK.startsWith('narrow-')).toBe(true);
  });

  it('reads the root package.json`s version, as the server does', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(readReleaseVersion()).toBe(pkg.version);
    expect(readReleaseVersion(join(ROOT, 'no-such-package.json'))).toBeNull();
  });

  it('takes a plain version only', () => {
    expect(releaseVersionOf('{"version":"0.300.131"}')).toBe('0.300.131');
    expect(releaseVersionOf('{"version":"1.2.3-alpha.1"}')).toBe('1.2.3-alpha.1');
    for (const text of [
      null,
      '',
      'not json',
      '{}',
      '{"version":3}',
      '{"version":"0.0.0"}',
      '{"version":"1.2"}',
      '{"version":"1.2.3 x"}',
      '{"version":"1.2.3; drop"}',
      `{"version":"1.2.3-${'a'.repeat(70)}"}`,
    ]) {
      expect(releaseVersionOf(text), String(text)).toBeNull();
    }
  });

  it('no version: no statement', async () => {
    const sent: unknown[] = [];
    const sql = ((...args: unknown[]) => {
      sent.push(args);
      return Promise.resolve([]);
    }) as never;
    expect(await ensureNarrowEpoch(sql, null)).toBe('no-version');
    expect(sent).toEqual([]);
  });

  it('one definer call that names the version and skips a version already written', async () => {
    const sent: { text: string; values: unknown[] }[] = [];
    let rows: unknown[] = [{ id: 1 }];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      sent.push({ text: strings.join('$').replace(/\s+/g, ' ').trim(), values });
      return Promise.resolve(rows);
    }) as never;
    expect(await ensureNarrowEpoch(sql, '1.2.3')).toBe('written');
    rows = [];
    expect(await ensureNarrowEpoch(sql, '1.2.3')).toBe('present');
    expect(sent).toHaveLength(2);
    // A definer call, as every miss row is written (no raw write SQL).
    expect(sent[0]!.text).toBe(
      `select "public"."mantle_actor_miss_log"('migrate', $, '', $) ` +
        'where not exists (select 1 from public.actor_check_misses where check_name = $ and detail = $)',
    );
    expect(sent[0]!.values).toEqual(['narrow-epoch', '1.2.3', 'narrow-epoch', '1.2.3']);
  });
});
