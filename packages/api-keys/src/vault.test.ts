/**
 * The vault write gateway's pure rules (vault.ts), without a database: a
 * name, a target, a kind's shape, the CSV reader, the approval default and
 * the mask. A refusal never echoes what was sent. Every value here is made
 * up and shaped not to look like a real key.
 */
import { describe, expect, it, vi } from 'vitest';
import { AccessError, InputError } from '@mantle/std';

vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callerHasArea: vi.fn(async () => false),
}));

const {
  approvalDefault,
  canonicalTarget,
  checkVaultShape,
  deleteVaultKey,
  importVaultKeys,
  parseCsv,
  parseVaultName,
  setVaultKey,
  testVaultKey,
} = await import('./vault');
const { maskPlaintext } = await import('./shape');

/** A private key block of the right armour and a made-up body. */
const KEY_BLOCK = [
  '-----BEGIN ',
  'OPENSSH PRIVATE KEY-----\nnot-a-key-body\n-----END ',
  'OPENSSH PRIVATE KEY-----',
].join('');

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(InputError);
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('a vault name', () => {
  it('is a slug, or slug/label; slug/default is the slug', () => {
    expect(parseVaultName('printer-07')).toEqual({
      service: 'printer-07',
      label: 'default',
      name: 'printer-07',
    });
    expect(parseVaultName('openrouter/agent')).toEqual({
      service: 'openrouter',
      label: 'agent',
      name: 'openrouter/agent',
    });
    expect(parseVaultName(' openrouter/default ')?.name).toBe('openrouter');
  });

  it('refuses anything else', () => {
    for (const bad of ['', 'a b', 'a/', '/a', 'a.b', 'a/b c', 'x'.repeat(65), 'a/b/c d', 'é']) {
      expect(parseVaultName(bad), bad).toBeNull();
    }
  });
});

describe('a target', () => {
  it('is a host with an optional port, or a web origin', () => {
    expect(canonicalTarget('Printer-07.LAN')).toBe('printer-07.lan');
    expect(canonicalTarget('192.0.2.12:2222')).toBe('192.0.2.12:2222');
    expect(canonicalTarget('[2001:db8::1]:22')).toBe('[2001:db8::1]:22');
    expect(canonicalTarget('https://API.example.com/')).toBe('https://api.example.com');
    expect(canonicalTarget('http://localhost:8080')).toBe('http://localhost:8080');
  });

  it('refuses a path, a query, a user, a wildcard, another scheme or a bad port', () => {
    for (const bad of [
      'https://api.example.com/v1',
      'https://api.example.com?x=1',
      'https://u:p@api.example.com',
      '*.example.com',
      'ftp://files.example.com',
      'host:0',
      'host:70000',
      'a b',
      '-bad.example.com',
      '',
    ]) {
      expect(canonicalTarget(bad), bad).toBeNull();
    }
  });
});

describe("a kind's shape", () => {
  const VALUE = 'test-not-a-real-secret';

  it('takes each kind with its own fields', () => {
    checkVaultShape('token', VALUE, {});
    checkVaultShape('password', VALUE, {});
    checkVaultShape('login', VALUE, { user: 'pi', sudoPassword: VALUE });
    checkVaultShape('ssh_key', KEY_BLOCK, { user: 'pi', passphrase: VALUE });
  });

  it('refuses a field of another kind, a missing user, a bad key block, a control character', () => {
    const messages = [
      refusal(() => checkVaultShape('token', VALUE, { user: 'pi' })),
      refusal(() => checkVaultShape('password', VALUE, { passphrase: VALUE })),
      refusal(() => checkVaultShape('login', VALUE, {})),
      refusal(() => checkVaultShape('ssh_key', KEY_BLOCK, {})),
      refusal(() => checkVaultShape('ssh_key', VALUE, { user: 'pi' })),
      refusal(() => checkVaultShape('token', `${VALUE}\n`, {})),
      refusal(() => checkVaultShape('login', VALUE, { user: 'p i' })),
    ];
    // No refusal echoes a value.
    for (const m of messages) expect(m).not.toContain(VALUE);
  });
});

describe('the CSV reader', () => {
  it('reads quoted cells, "" inside quotes, CRLF, and a cell over several lines', () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n\r\nx,"y\nz",\n')).toEqual([
      ['a', 'b,c', 'd "e"'],
      ['x', 'y\nz', ''],
    ]);
  });

  it('names the row of a quote never closed, and not its content', () => {
    const m = refusal(() => parseCsv('a,b\nc,"secret-cell'));
    expect(m).toMatch(/row 2/);
    expect(m).not.toContain('secret-cell');
  });
});

describe('the defaults', () => {
  it('approval is on for every kind but a token', () => {
    expect(approvalDefault('token')).toBe(false);
    for (const k of ['password', 'ssh_key', 'login'] as const)
      expect(approvalDefault(k)).toBe(true);
  });

  it('a short value is masked whole', () => {
    expect(maskPlaintext('short-secret-15')).toBe('••••');
    expect(maskPlaintext('test-long-made-up-value')).toBe('test…alue');
  });
});

describe('the gate', () => {
  it('refuses a caller without the keys area before any database work', async () => {
    const who = { loginId: null, via: 'mcp' } as const;
    await expect(
      setVaultKey(who, 'o', { ref: { name: 'printer-07' }, value: 'x' }),
    ).rejects.toBeInstanceOf(AccessError);
    await expect(deleteVaultKey(who, 'o', { name: 'printer-07' })).rejects.toBeInstanceOf(
      AccessError,
    );
    await expect(testVaultKey(who, 'o', { name: 'printer-07' })).rejects.toBeInstanceOf(
      AccessError,
    );
    await expect(importVaultKeys(who, 'o', 'printer-07,token,,,x,')).rejects.toBeInstanceOf(
      AccessError,
    );
  });

  it("refuses the connectors' reserved names before the gate", async () => {
    const who = { loginId: null, via: 'web' } as const;
    await expect(
      setVaultKey(who, 'o', { ref: { name: 'mcp-site' }, value: 'x' }),
    ).rejects.toBeInstanceOf(InputError);
  });
});
