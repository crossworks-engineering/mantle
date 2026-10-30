/**
 * The vault's write tools (toolsmith/vault-keys.ts) over a stand-in gateway: MCP only,
 * the value inputs redacted, the input mapped to the gateway as sent, a
 * refusal said in the gateway's words, a connector's marks voided after a
 * secret is written, and no reply carrying a value. A replace or delete
 * the gateway holds parks one pending call naming the hold and the key's
 * preview, never the value; an approved run makes the held change.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InputError } from '@mantle/std';
import { VAULT_KINDS } from '@mantle/db';

const h = vi.hoisted(() => ({
  set: vi.fn(),
  test: vi.fn(),
  del: vi.fn(),
  imp: vi.fn(),
  apply: vi.fn(),
  release: vi.fn(async () => {}),
  park: vi.fn(async () => 'pending-1' as string | null),
  notify: vi.fn(async () => {}),
  after: vi.fn(async () => {}),
}));

vi.mock('@mantle/api-keys', () => ({
  setVaultKey: h.set,
  testVaultKey: h.test,
  deleteVaultKey: h.del,
  importVaultKeys: h.imp,
  applyHeldVaultWrites: h.apply,
  releaseVaultHolds: h.release,
}));
vi.mock('@mantle/db', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  parkPendingCall: h.park,
}));
vi.mock('./vault-follow-up', () => ({ afterVaultKeyReplaced: h.after }));
vi.mock('./pending-notify', () => ({ notifyPendingCreated: h.notify }));
vi.mock('./pending-origin', () => ({
  pendingOriginOfCaller: vi.fn(async () => ({ v: 1, scope: null, surface: null })),
}));

const { VAULT_KEY_TOOLS, VAULT_KIND_ENUM, api_key_set, api_key_import, api_key_delete } =
  await import('./toolsmith/vault-keys');

const SECRET = 'test-not-a-real-secret-value';
const ctx = {
  ownerId: 'owner-1',
  surface: { kind: 'owner', via: 'mcp', loginId: 'login-1' },
} as never;

const KEY_ID = '11111111-1111-4111-8111-111111111111';
const HOLD = '22222222-2222-4222-8222-222222222222';
const key = {
  id: KEY_ID,
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
  for (const f of [h.set, h.test, h.del, h.imp, h.apply, h.release, h.notify, h.after]) {
    f.mockReset();
  }
  h.park.mockReset();
  h.park.mockResolvedValue('pending-1');
});

/** An approved pending call's context (pending.ts sets the caller). */
const approvedCtx = {
  ownerId: 'owner-1',
  surface: { kind: 'owner', via: 'mcp', loginId: 'login-1' },
  caller: { entry: 'pending', via: 'process', approval: { approver: 'owner-1' } },
} as never;

const held = { holdId: HOLD, kind: 'login', target: ['pi-lab-3.lan'], masked: '••••' };

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

  it('parks a held replace for approval: the hold and the preview, never the value', async () => {
    h.set.mockResolvedValueOnce({ key, op: 'held', secretWritten: false, held });
    const r = await api_key_set.handler({ name: 'pi-lab-3', value: SECRET }, ctx);
    expect(h.park).toHaveBeenCalledTimes(1);
    const parked = (h.park.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(parked).toMatchObject({
      ownerId: 'owner-1',
      agentId: null,
      toolSlug: 'api_key_set',
      loginId: 'login-1',
      args: {
        op: 'replace',
        name: 'pi-lab-3',
        kind: 'login',
        target: ['pi-lab-3.lan'],
        masked: '••••',
        key_id: KEY_ID,
        hold_id: HOLD,
      },
    });
    expect(Object.keys(parked.args as object).sort()).toEqual(
      ['hold_id', 'key_id', 'kind', 'masked', 'name', 'op', 'target'].sort(),
    );
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.after).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      ok: true,
      output: { status: 'queued_for_approval', pending_id: 'pending-1' },
    });
    expect(JSON.stringify([r, h.park.mock.calls, h.notify.mock.calls])).not.toContain(SECRET);
  });

  it('drops the hold when nothing could be parked', async () => {
    h.set.mockResolvedValueOnce({ key, op: 'held', secretWritten: false, held });
    h.park.mockResolvedValueOnce(null);
    const r = await api_key_set.handler({ name: 'pi-lab-3', value: SECRET }, ctx);
    expect(r.ok).toBe(false);
    expect(h.release).toHaveBeenCalledWith('owner-1', HOLD, [KEY_ID]);
  });

  it('an approved run makes the held change, naming its approver, and writes nothing else', async () => {
    h.apply.mockResolvedValueOnce({ keys: [{ key, op: 'replace', secretWritten: true }] });
    const r = await api_key_set.handler(
      { op: 'replace', name: 'pi-lab-3', key_id: KEY_ID, hold_id: HOLD },
      approvedCtx,
    );
    expect(h.set).not.toHaveBeenCalled();
    expect(h.apply).toHaveBeenCalledWith(
      { loginId: 'login-1', via: 'mcp', approval: { approver: 'owner-1' } },
      'owner-1',
      HOLD,
      [KEY_ID],
    );
    expect(h.after).toHaveBeenCalledWith('owner-1', 'pi-lab-3', 'default');
    expect(r).toMatchObject({ ok: true, output: { keys: [{ name: 'pi-lab-3', op: 'replace' }] } });
  });

  it('an approved run with no hold, or a value of its own, changes nothing', async () => {
    const r = await api_key_set.handler({ name: 'pi-lab-3', value: SECRET }, approvedCtx);
    expect(r.ok).toBe(false);
    expect(h.set).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });
});

describe('api_key_import', () => {
  it('writes through the gateway with a follow-up per written row', async () => {
    h.imp.mockImplementationOnce(async (_w, _o, _csv, afterEach) => {
      const written = { key, op: 'add', secretWritten: true };
      await afterEach(written);
      return { ok: true, added: 1, replaced: 0, held: 0, keys: [written] };
    });
    const r = await api_key_import.handler(
      { csv: `pi-lab-3,login,pi-lab-3.lan,pi,${SECRET},pis` },
      ctx,
    );
    expect(r).toMatchObject({ ok: true, output: { added: 1, replaced: 0 } });
    expect(h.after).toHaveBeenCalledWith('owner-1', 'pi-lab-3', 'default');
    expect(h.park).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it('parks the rows that replace a key as one pending call; the adds land', async () => {
    const other = { ...key, id: '33333333-3333-4333-8333-333333333333', name: 'printer-07' };
    h.imp.mockResolvedValueOnce({
      ok: true,
      added: 1,
      replaced: 0,
      held: 1,
      holdId: HOLD,
      keys: [
        { key, op: 'held', secretWritten: false, held },
        { key: other, op: 'add', secretWritten: true },
      ],
    });
    const r = await api_key_import.handler(
      { csv: `pi-lab-3,login,pi-lab-3.lan,pi,${SECRET},` },
      ctx,
    );
    expect(h.park).toHaveBeenCalledTimes(1);
    const parked = (h.park.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(parked).toMatchObject({
      toolSlug: 'api_key_import',
      args: {
        op: 'replace',
        hold_id: HOLD,
        keys: [{ name: 'pi-lab-3', kind: 'login', key_id: KEY_ID, masked: '••••' }],
      },
    });
    expect(r).toMatchObject({
      ok: true,
      output: {
        added: 1,
        keys: [{ name: 'printer-07', op: 'add' }],
        waiting: ['pi-lab-3'],
        status: 'queued_for_approval',
        pending_id: 'pending-1',
      },
    });
    expect(JSON.stringify([r, h.park.mock.calls])).not.toContain(SECRET);
  });

  it('an approved import makes every held row through the gateway', async () => {
    h.apply.mockResolvedValueOnce({ keys: [{ key, op: 'replace', secretWritten: true }] });
    const r = await api_key_import.handler(
      { op: 'replace', hold_id: HOLD, keys: [{ name: 'pi-lab-3', key_id: KEY_ID }] },
      approvedCtx,
    );
    expect(h.imp).not.toHaveBeenCalled();
    expect(h.apply.mock.calls[0]!.slice(2)).toEqual([HOLD, [KEY_ID]]);
    expect(r.ok).toBe(true);
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
    h.del.mockResolvedValueOnce({ key });
    const r = await api_key_delete.handler({ name: 'pi-lab-3' }, ctx);
    expect(h.del).toHaveBeenCalledWith({ loginId: 'login-1', via: 'mcp' }, 'owner-1', {
      name: 'pi-lab-3',
    });
    expect(r).toMatchObject({ ok: true, output: { deleted: { name: 'pi-lab-3', kind: 'login' } } });
  });

  it("names an API key's connection in the actor, for the audit row", async () => {
    h.del.mockResolvedValueOnce({ key });
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

  it('parks a held delete for approval and deletes nothing yet', async () => {
    h.del.mockResolvedValueOnce({ key, held });
    const r = await api_key_delete.handler({ name: 'pi-lab-3' }, ctx);
    expect((h.park.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      toolSlug: 'api_key_delete',
      args: { op: 'delete', name: 'pi-lab-3', key_id: KEY_ID, hold_id: HOLD },
    });
    expect(r).toMatchObject({ ok: true, output: { status: 'queued_for_approval' } });
  });

  it('an approved delete makes the held delete', async () => {
    h.apply.mockResolvedValueOnce({ keys: [{ key, op: 'delete', secretWritten: false }] });
    const r = await api_key_delete.handler(
      { op: 'delete', name: 'pi-lab-3', key_id: KEY_ID, hold_id: HOLD },
      approvedCtx,
    );
    expect(h.del).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, output: { keys: [{ name: 'pi-lab-3', op: 'delete' }] } });
  });

  it('answers a missing key without echoing the name', async () => {
    h.del.mockResolvedValueOnce(null);
    const r = await api_key_delete.handler({ name: 'gone-key' }, ctx);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('gone-key');
  });
});
