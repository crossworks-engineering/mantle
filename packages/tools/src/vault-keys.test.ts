/**
 * The vault's write tools (toolsmith/vault-keys.ts) over a stand-in gateway: MCP only,
 * the value inputs redacted, the input mapped to the gateway as sent, a
 * refusal said in the gateway's words, a connector's marks voided after a
 * secret is written, and no reply carrying a value.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InputError } from '@mantle/std';
import { VAULT_KINDS } from '@mantle/db';

const h = vi.hoisted(() => ({
  set: vi.fn(),
  test: vi.fn(),
  del: vi.fn(),
  imp: vi.fn(),
  after: vi.fn(async () => {}),
}));

vi.mock('@mantle/api-keys', () => ({
  setVaultKey: h.set,
  testVaultKey: h.test,
  deleteVaultKey: h.del,
  importVaultKeys: h.imp,
}));
vi.mock('./vault-follow-up', () => ({ afterVaultKeyReplaced: h.after }));

const { VAULT_KEY_TOOLS, VAULT_KIND_ENUM, api_key_set, api_key_import, api_key_delete } =
  await import('./toolsmith/vault-keys');

const SECRET = 'test-not-a-real-secret-value';
const ctx = {
  ownerId: 'owner-1',
  surface: { kind: 'owner', via: 'mcp', loginId: 'login-1' },
} as never;

const key = {
  id: 'k1',
  name: 'pi-lab-3',
  kind: 'login',
  service: 'pi-lab-3',
  label: 'default',
  target: ['pi-lab-3.lan'],
  tags: ['pis'],
  needsApproval: true,
  viaTailnet: true,
  masked: '••••',
  anthropicWorkspaceId: null,
  lastUsed: null,
  useCount: 0,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

beforeEach(() => {
  for (const f of [h.set, h.test, h.del, h.imp, h.after]) f.mockReset();
});

describe('the vault write tools', () => {
  it('are MCP only, write tools of the keys area, and redact every value input', () => {
    expect(VAULT_KEY_TOOLS.map((t) => t.slug)).toEqual([
      'api_key_set',
      'api_key_test',
      'api_key_delete',
      'api_key_import',
    ]);
    for (const t of VAULT_KEY_TOOLS) {
      expect(t.mcpOnly, t.slug).toBe(true);
      expect(t.policy.scope, t.slug).toEqual({ area: 'keys', systemWhole: true });
      expect(t.policy.effect, t.slug).toBe('write');
    }
    expect(api_key_set.redactInputFields).toEqual(['value', 'user', 'passphrase', 'sudo_password']);
    expect(api_key_import.redactInputFields).toEqual(['csv']);
    expect([...VAULT_KIND_ENUM]).toEqual([...VAULT_KINDS]);
  });
});

describe('api_key_set', () => {
  it('maps its input, voids marks after a written secret, and answers no value', async () => {
    h.set.mockResolvedValue({ key, op: 'add', secretWritten: true });
    const r = await api_key_set.handler(
      {
        name: 'pi-lab-3',
        kind: 'login',
        value: SECRET,
        user: 'pi',
        sudo_password: null,
        target: 'pi-lab-3.lan',
        tags: ['pis'],
        needs_approval: true,
        via_tailnet: true,
      },
      ctx,
    );
    expect(h.set).toHaveBeenCalledWith({ loginId: 'login-1', via: 'mcp' }, 'owner-1', {
      ref: { name: 'pi-lab-3' },
      kind: 'login',
      value: SECRET,
      user: 'pi',
      sudoPassword: null,
      target: ['pi-lab-3.lan'],
      tags: ['pis'],
      needsApproval: true,
      viaTailnet: true,
    });
    expect(h.after).toHaveBeenCalledWith('owner-1', 'pi-lab-3', 'default');
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('a metadata change voids nothing; a refusal is the gateway text', async () => {
    h.set.mockResolvedValueOnce({ key, op: 'replace', secretWritten: false });
    await api_key_set.handler({ name: 'pi-lab-3', tags: [] }, ctx);
    expect(h.after).not.toHaveBeenCalled();
    h.set.mockRejectedValueOnce(new InputError('a login needs user (the name it logs in as).'));
    expect(await api_key_set.handler({ name: 'x', value: SECRET }, ctx)).toEqual({
      ok: false,
      error: 'a login needs user (the name it logs in as).',
    });
    h.set.mockResolvedValueOnce(null);
    const nf = await api_key_set.handler({ name: 'x' }, ctx);
    expect(nf.ok).toBe(false);
  });
});

describe('api_key_import', () => {
  it('writes through the gateway with a follow-up per written row', async () => {
    h.imp.mockImplementationOnce(async (_w, _o, _csv, afterEach) => {
      const written = { key, op: 'add', secretWritten: true };
      await afterEach(written);
      return { ok: true, added: 1, replaced: 0, keys: [written] };
    });
    const r = await api_key_import.handler(
      { csv: `pi-lab-3,login,pi-lab-3.lan,pi,${SECRET},pis` },
      ctx,
    );
    expect(r).toMatchObject({ ok: true, output: { added: 1, replaced: 0 } });
    expect(h.after).toHaveBeenCalledWith('owner-1', 'pi-lab-3', 'default');
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('lists the bad rows and never a cell', async () => {
    h.imp.mockResolvedValueOnce({
      ok: false,
      failed: [
        { row: 3, reason: 'the kind column must be one of token, password, ssh_key, login.' },
      ],
    });
    const r = await api_key_import.handler({ csv: `a,lockpick,,,${SECRET},` }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/row 3: the kind column/);
    expect(r.error).not.toContain(SECRET);
  });
});

describe('api_key_delete', () => {
  it('deletes the named key through the gateway and answers what went, no value', async () => {
    h.del.mockResolvedValueOnce(key);
    const r = await api_key_delete.handler({ name: 'pi-lab-3' }, ctx);
    expect(h.del).toHaveBeenCalledWith({ loginId: 'login-1', via: 'mcp' }, 'owner-1', {
      name: 'pi-lab-3',
    });
    expect(r).toMatchObject({ ok: true, output: { deleted: { name: 'pi-lab-3', kind: 'login' } } });
  });

  it("names an API key's connection in the actor, for the audit row", async () => {
    h.del.mockResolvedValueOnce(key);
    const keyCtx = {
      ownerId: 'owner-1',
      surface: {
        kind: 'owner',
        via: 'mcp',
        loginId: 'login-1',
        mcp: { via: 'key', keyId: 'key-7', write: true },
      },
    } as never;
    await api_key_delete.handler({ name: 'pi-lab-3' }, keyCtx);
    expect(h.del.mock.calls[0]![0]).toEqual({
      loginId: 'login-1',
      via: 'mcp',
      connection: { via: 'key', keyId: 'key-7' },
    });
  });

  it('answers a missing key without echoing the name', async () => {
    h.del.mockResolvedValueOnce(null);
    const r = await api_key_delete.handler({ name: 'gone-key' }, ctx);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('gone-key');
  });
});
