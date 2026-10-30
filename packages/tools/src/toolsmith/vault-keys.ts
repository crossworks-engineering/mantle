/**
 * The vault's write tools over MCP (credential vault v2, part 1): add or
 * replace, test, delete and CSV import of a secret, beside api_key_refs.
 * Each calls the vault's one write gateway (@mantle/api-keys vault.ts),
 * which holds the gate (the keys area), the checks and the audit row; a
 * handler here only maps the input and the answer.
 *
 * `mcpOnly`: the owner's own clients put secrets in; no in-brain agent is
 * ever granted a vault write. Write-only: a reply carries the name, kind,
 * target, tags and the masked preview, never a value; the value inputs are
 * redacted from every trace and from the MCP call log.
 */
import {
  deleteVaultKey,
  importVaultKeys,
  setVaultKey,
  testVaultKey,
  type VaultActor,
  type VaultKeySummary,
  type VaultKind,
  type VaultSetInput,
} from '@mantle/api-keys';
import { AccessError, ConflictError, InputError } from '@mantle/std';
import { afterVaultKeyReplaced } from '../vault-follow-up';
import { CS } from '../client-sourced-rule';
import { str } from '../coerce';
import { type BuiltinToolDef, type ToolHandlerContext, type ToolHandlerResult } from '../types';

const VAULT_WRITE = 'changes the secrets tools and agents sign in with';

/** The vault's kinds as the schema offers them: a literal, so a module
 *  that stands in for @mantle/api-keys in a test still loads this one
 *  (vault-keys.test.ts pins it equal to VAULT_KINDS). */
export const VAULT_KIND_ENUM: readonly VaultKind[] = ['token', 'password', 'ssh_key', 'login'];

/** Who writes, for the vault's audit row: the connection's login (none on
 *  the owner's stdio client). */
function vaultActor(ctx: ToolHandlerContext): VaultActor {
  const s = ctx.surface;
  const loginId = s && 'loginId' in s && typeof s.loginId === 'string' ? s.loginId : null;
  return { loginId, via: 'mcp' };
}

/** A secret as a tool answers it: never a value. */
function reply(key: VaultKeySummary) {
  return {
    name: key.name,
    kind: key.kind,
    target: key.target,
    tags: key.tags,
    needs_approval: key.needsApproval,
    via_tailnet: key.viaTailnet,
    masked: key.masked,
  };
}

/** The gateway's refusals, said as they are (fixed texts that never echo
 *  an input); anything else is a fault for the dispatcher to mask. */
async function answer(fn: () => Promise<ToolHandlerResult>): Promise<ToolHandlerResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InputError || err instanceof ConflictError || err instanceof AccessError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}

/** Never echoes the name: a value sent in the wrong field stays out. */
const NOT_FOUND = 'No vault key has that name: list the names with api_key_refs.';

function strList(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return [v];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/** An optional text field: absent keeps, null or '' clears. */
function optText(input: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in input)) return undefined;
  const v = input[key];
  return v === null ? null : str(v);
}

const NAME_PARAM = {
  type: 'string',
  minLength: 1,
  maxLength: 130,
  description:
    "What agents call the secret: a slug, optionally '/label' (printer-07, pi-lab-3, openrouter/agent). Today's keys are named service or service/label.",
};

export const api_key_set: BuiltinToolDef = {
  slug: 'api_key_set',
  mcpOnly: true,
  policy: {
    matrix: { none: 'a vault key is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'keys', systemWhole: true },
    peerRisky: true,
    idempotent: true, // a set
    recipe: { step: 'forbidden' },
    clientSourced: CS.always(VAULT_WRITE),
  },
  name: 'Add or replace a vault key',
  description:
    'Add a secret to the vault, or replace the one with that name, and return its name, kind, target, tags and masked preview, **never the value**. Kinds: token (an API key), password, ssh_key (a private key plus `user`), login (`user` plus a password in `value`). On a replace, leave out what stays and pass null to clear an optional field; changing `kind` needs a new `value`. A password, SSH key or login needs `target` and waits for the owner on each use unless `needs_approval` is false. Do not echo the value back to the user. List names with `api_key_refs`; many at once: `api_key_import`.',
  inputSchema: {
    type: 'object',
    properties: {
      name: NAME_PARAM,
      kind: {
        type: 'string',
        enum: [...VAULT_KIND_ENUM],
        description: 'Kind of secret; a new key without one is a token.',
      },
      value: {
        type: 'string',
        minLength: 1,
        maxLength: 16384,
        description: 'The secret itself: the token, the password, or the whole private key block.',
      },
      user: {
        type: ['string', 'null'],
        maxLength: 256,
        description: 'The user name a login or an SSH key logs in as, e.g. pi.',
      },
      passphrase: {
        type: ['string', 'null'],
        maxLength: 1024,
        description: "An SSH key's passphrase, when it has one.",
      },
      sudo_password: {
        type: ['string', 'null'],
        maxLength: 1024,
        description: 'The sudo password for a login or an SSH key, fed to sudo by the brain.',
      },
      target: {
        type: 'array',
        items: { type: 'string', maxLength: 300 },
        maxItems: 32,
        description:
          'Hosts or web origins it may be used on, e.g. ["printer-07.lan", "192.0.2.12:2222"] or ["https://api.example.com"]. Replaces the list.',
      },
      tags: {
        type: 'array',
        items: { type: 'string', maxLength: 40 },
        maxItems: 20,
        description: 'Groups an agent is granted by, e.g. ["printers"]. Replaces the list.',
      },
      needs_approval: {
        type: 'boolean',
        description: 'Each use waits for the owner to approve it.',
      },
      via_tailnet: {
        type: 'boolean',
        description: 'The target is reached through the tailnet (a device on a home or site LAN).',
      },
    },
    required: ['name'],
  },
  redactInputFields: ['value', 'passphrase', 'sudo_password'],
  handler: (input, ctx) =>
    answer(async () => {
      const name = str(input.name);
      const target = strList(input.target);
      const tags = strList(input.tags);
      const set: VaultSetInput = {
        ref: { name },
        ...(input.kind !== undefined ? { kind: str(input.kind) as VaultKind } : {}),
        ...(input.value !== undefined ? { value: str(input.value) } : {}),
        ...(optText(input, 'user') !== undefined ? { user: optText(input, 'user') } : {}),
        ...(optText(input, 'passphrase') !== undefined
          ? { passphrase: optText(input, 'passphrase') }
          : {}),
        ...(optText(input, 'sudo_password') !== undefined
          ? { sudoPassword: optText(input, 'sudo_password') }
          : {}),
        ...(target ? { target } : {}),
        ...(tags ? { tags } : {}),
        ...(typeof input.needs_approval === 'boolean'
          ? { needsApproval: input.needs_approval }
          : {}),
        ...(typeof input.via_tailnet === 'boolean' ? { viaTailnet: input.via_tailnet } : {}),
      };
      const result = await setVaultKey(vaultActor(ctx), ctx.ownerId, set);
      if (!result) return { ok: false, error: NOT_FOUND };
      if (result.secretWritten) {
        await afterVaultKeyReplaced(ctx.ownerId, result.key.service, result.key.label);
      }
      ctx.step?.setOutput({ name: result.key.name, kind: result.key.kind, op: result.op });
      return {
        ok: true,
        output: {
          ...reply(result.key),
          op: result.op,
          message:
            result.op === 'add'
              ? 'Added. The value is sealed: confirm by name only, never repeat it.'
              : 'Replaced. The value is sealed: confirm by name only, never repeat it.',
        },
      };
    }),
};

export const api_key_test: BuiltinToolDef = {
  slug: 'api_key_test',
  mcpOnly: true,
  policy: {
    outside: { via: 'http' }, // a token's provider probe
    matrix: { none: 'a vault key is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'keys', systemWhole: true },
    peerRisky: true,
    recipe: { step: 'forbidden' },
    clientSourced: CS.always('sends a vault key to its provider'),
  },
  name: 'Test a vault key',
  description:
    "Test a vault key and return ok and a one-line message, never the value. A token is probed against its provider at no cost (the same as Settings → Keys' Test); a password, SSH key or login is checked for its stored shape only, with no login to the target yet. Use after `api_key_set`.",
  inputSchema: {
    type: 'object',
    properties: { name: NAME_PARAM },
    required: ['name'],
  },
  handler: (input, ctx) =>
    answer(async () => {
      const name = str(input.name);
      const result = await testVaultKey(vaultActor(ctx), ctx.ownerId, { name });
      if (!result) return { ok: false, error: NOT_FOUND };
      return {
        ok: true,
        output: {
          name: result.name,
          kind: result.kind,
          ok: result.ok,
          message: result.message,
          ...(result.modelsFound !== undefined ? { models_found: result.modelsFound } : {}),
        },
      };
    }),
};

export const api_key_delete: BuiltinToolDef = {
  slug: 'api_key_delete',
  mcpOnly: true,
  policy: {
    destructive: true, // the sealed value is gone; nothing keeps it
    matrix: { none: 'a vault key is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'keys', systemWhole: true },
    peerRisky: true,
    recipe: { step: 'forbidden' },
    clientSourced: CS.always(VAULT_WRITE),
  },
  name: 'Delete a vault key',
  description:
    'Delete a vault key by name and return what was deleted (name, kind, target), never the value. Not reversible: agents, workers and tools that use it are left with no key, so check the name with `api_key_refs` and ask the user first. To change a value use `api_key_set` instead.',
  inputSchema: {
    type: 'object',
    properties: { name: NAME_PARAM },
    required: ['name'],
  },
  handler: (input, ctx) =>
    answer(async () => {
      const name = str(input.name);
      const gone = await deleteVaultKey(vaultActor(ctx), ctx.ownerId, { name });
      if (!gone) return { ok: false, error: NOT_FOUND };
      return { ok: true, output: { deleted: reply(gone) } };
    }),
};

export const api_key_import: BuiltinToolDef = {
  slug: 'api_key_import',
  mcpOnly: true,
  policy: {
    matrix: { none: 'a vault key is not an item' },
    effect: 'write',
    spends: 'none',
    scope: { area: 'keys', systemWhole: true },
    peerRisky: true,
    idempotent: true, // each row a set
    recipe: { step: 'forbidden' },
    clientSourced: CS.always(VAULT_WRITE),
  },
  name: 'Import vault keys from CSV',
  description:
    "Add or replace many vault keys from CSV text and return the counts and each key's name, kind and target, never a value. Columns: name,kind,target,user,secret,tags (a header row is skipped; targets and tags split on ';'; quote an SSH key's lines). Every row is checked first: one bad row and **nothing is written**, and each bad row comes back by number with the reason. For one key use `api_key_set`.",
  inputSchema: {
    type: 'object',
    properties: {
      csv: {
        type: 'string',
        minLength: 1,
        maxLength: 1048576,
        description:
          'The CSV text, e.g. "name,kind,target,user,secret,tags\\npi-lab-3,login,pi-lab-3.lan,pi,…,pis".',
      },
    },
    required: ['csv'],
  },
  redactInputFields: ['csv'],
  handler: (input, ctx) =>
    answer(async () => {
      const result = await importVaultKeys(vaultActor(ctx), ctx.ownerId, str(input.csv));
      if (!result.ok) {
        return {
          ok: false,
          error: `Nothing was imported. Fix these rows and send the whole CSV again: ${result.failed
            .map((f) => `row ${f.row}: ${f.reason}`)
            .join(' ')}`,
        };
      }
      for (const { key, secretWritten } of result.keys) {
        if (secretWritten) await afterVaultKeyReplaced(ctx.ownerId, key.service, key.label);
      }
      ctx.step?.setOutput({ added: result.added, replaced: result.replaced });
      return {
        ok: true,
        output: {
          added: result.added,
          replaced: result.replaced,
          keys: result.keys.map((k) => ({ ...reply(k.key), op: k.op })),
        },
      };
    }),
};

/** The vault's write tools, registered on the MCP surface only
 *  (build-server.ts, beside the Toolsmith set and api_key_refs). */
export const VAULT_KEY_TOOLS: readonly BuiltinToolDef[] = [
  api_key_set,
  api_key_test,
  api_key_delete,
  api_key_import,
];
