/**
 * The vault's ONE write gateway (credential vault v2, part 1): set (add or
 * replace), test, delete and CSV import of a secret, for every client that
 * writes the vault: the Settings > Keys routes and the api_key_* MCP tools.
 *
 * The rules, each enforced here and nowhere else:
 *  - One gate, the Keys screen's: the caller may do the Admin `keys` area
 *    (callerHasArea). A route and a tool call this; neither checks for it.
 *  - Write-only. A reply carries the name, kind, target, tags and the masked
 *    preview, never a value. An error never echoes what the caller sent (a
 *    misplaced value could sit in any field): it names the field, or the
 *    CSV row and column.
 *  - Each write is an audit_log row: who, which name, what changed (by
 *    column), never a value.
 *  - A secret of a kind other than token is never opened by a read path
 *    (index.ts openKeyRow reads tokens only). Its Test here checks the
 *    stored shape and opens it in process only; the network login is part 3.
 *  - Nothing loosens by itself: approval defaults on for a password, an SSH
 *    key and a login, and a kind change never turns it off unless the caller
 *    says so.
 *
 * Internal writers that seal connector or sandbox state (mcp-oauth.ts,
 * sandbox_publish) and onboarding keep setApiKey: they are not an owner's
 * client.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  apiKeys,
  auditLog,
  callerHasArea,
  conflictOnUnique,
  db,
  narrowNeedsSpot,
  onFullSystemRoute,
  type ApiKey,
  type VaultKind,
  VAULT_KINDS,
} from '@mantle/db';
import { open, seal } from '@mantle/crypto';
import { AccessError, InputError, isMcpManagedSecretService, UUID_RE } from '@mantle/std';
import type { TestApiKeyResult } from '@mantle/client-types';
import { checkedWorkspaceId, maskPlaintext } from './shape';
import { probeApiKey } from './probe';
import { log } from '@mantle/tracing';

export { VAULT_KINDS, type VaultKind };

/** Who writes: the login (or none, the owner's own stdio MCP) and the
 *  client, for the audit row. */
export type VaultActor = Readonly<{
  loginId: string | null;
  email?: string | null;
  via: 'web' | 'mcp';
}>;

/** A secret as every vault reply shows it: never a value. */
export type VaultKeySummary = {
  id: string;
  name: string;
  kind: VaultKind;
  service: string;
  label: string;
  target: string[];
  tags: string[];
  needsApproval: boolean;
  viaTailnet: boolean;
  /** First-4 + last-4 of a long token; dots for anything else. */
  masked: string;
  /** Anthropic only: the workspace id the key names (not secret). */
  anthropicWorkspaceId: string | null;
  lastUsed: Date | null;
  useCount: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Which secret: its row id (the Keys screen) or its name (agents, CSV). */
export type VaultRef = Readonly<{ id: string } | { name: string }>;

/**
 * A set. On an add, `value` is required and every unset field takes its
 * default; on a replace, an unset field keeps what the row has and `null`
 * clears an optional one. `kind` changes only with a new `value`.
 */
export type VaultSetInput = {
  ref: VaultRef;
  kind?: VaultKind;
  /** The token, the password, or the SSH private key. */
  value?: string;
  /** login and ssh_key: the user name. */
  user?: string | null;
  /** ssh_key only: the private key's passphrase. */
  passphrase?: string | null;
  /** ssh_key and login: the sudo password an executor feeds on stdin. */
  sudoPassword?: string | null;
  target?: readonly string[];
  tags?: readonly string[];
  needsApproval?: boolean;
  viaTailnet?: boolean;
  /** Anthropic tokens only (index.ts checkedWorkspaceId). */
  anthropicWorkspaceId?: string | null;
};

export type VaultSetResult = {
  key: VaultKeySummary;
  op: 'add' | 'replace';
  /** A value or fields were written (an add, or a replace of either): a
   *  connector that signs in with this name now sends another secret, so
   *  the caller voids its read-only marks (access matrix T7,
   *  afterVaultKeyReplaced). */
  secretWritten: boolean;
};

export type VaultTestResult = TestApiKeyResult & { name: string; kind: VaultKind };

export type VaultImportResult =
  | { ok: true; added: number; replaced: number; keys: VaultSetResult[] }
  | { ok: false; failed: { row: number; reason: string }[] };

// ── Shapes ───────────────────────────────────────────────────────────────────

const SERVICE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LABEL_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const TAG_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** C0 controls and DEL: never in a token, a password or a user. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_TARGETS = 32;
const MAX_TAGS = 20;
const MAX_VALUE = 8192;
const MAX_SSH_KEY = 16384;
const MAX_FIELD = 1024;
const MAX_USER = 256;
export const VAULT_IMPORT_MAX_ROWS = 500;

const KIND_LABEL: Record<VaultKind, string> = {
  token: 'Token',
  password: 'Password',
  ssh_key: 'SSH key',
  login: 'Login',
};

/** Each use waits for the owner by default for every kind but a token
 *  (Jason's answers, 2026-10-30). */
export function approvalDefault(kind: VaultKind): boolean {
  return kind !== 'token';
}

/**
 * A name as agents say it, split into the row's service and label: `svc`
 * is svc/default, `svc/label` is itself, `svc/default` is `svc` (0346's
 * generated `name`). Null when it is no name; the reason never echoes it.
 */
export function parseVaultName(
  raw: string,
): { service: string; label: string; name: string } | null {
  const s = raw.trim();
  const slash = s.indexOf('/');
  const service = slash < 0 ? s : s.slice(0, slash);
  const label = slash < 0 ? 'default' : s.slice(slash + 1);
  if (!SERVICE_RE.test(service) || !LABEL_RE.test(label)) return null;
  return { service, label, name: label === 'default' ? service : `${service}/${label}` };
}

const NAME_RULE =
  "a name is letters, digits, '_' or '-' (e.g. printer-07), optionally '/' and a label of letters, digits, '_', '.' or '-' (e.g. openrouter/agent)";

/** One target, canonical: a web origin (`https://api.example.com`, scheme
 *  and host lowercased, no path) or a host with an optional port (a DNS
 *  name, an IPv4 address or a bracketed IPv6 one). Null: not a target. */
export function canonicalTarget(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 300 || /\s|\*/.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || u.search || u.hash) return null;
    if (u.pathname !== '/' && u.pathname !== '') return null;
    return u.origin;
  }
  const m = /^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}))?$/i.exec(s);
  if (!m) return null;
  const host = m[1]!.toLowerCase();
  const port = m[2];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  const okHost = host.startsWith('[')
    ? isIpv6(host.slice(1, -1))
    : IPV4_RE.test(host) ||
      (host.length <= 253 && host.split('.').every((l) => HOST_LABEL_RE.test(l)));
  if (!okHost) return null;
  return port !== undefined ? `${host}:${Number(port)}` : host;
}

function isIpv6(s: string): boolean {
  try {
    return new URL(`http://[${s}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

function canonicalTargets(list: readonly string[]): string[] {
  if (list.length > MAX_TARGETS) {
    throw new InputError(`target takes at most ${MAX_TARGETS} hosts or origins.`);
  }
  const out: string[] = [];
  for (const [i, raw] of list.entries()) {
    const t = canonicalTarget(raw);
    if (!t) {
      throw new InputError(
        `target ${i + 1} is not a host (printer-07.lan, 192.0.2.12, host:2222) or a web origin (https://api.example.com, no path).`,
      );
    }
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function canonicalTags(list: readonly string[]): string[] {
  if (list.length > MAX_TAGS) throw new InputError(`tags takes at most ${MAX_TAGS} tags.`);
  const out: string[] = [];
  for (const [i, raw] of list.entries()) {
    const t = raw.trim().toLowerCase();
    if (!TAG_RE.test(t)) {
      throw new InputError(
        `tag ${i + 1} must be lower-case letters, digits, '_', '.' or '-', up to 40 (e.g. printers).`,
      );
    }
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** The fields sealed in fields_enc. Keys absent when empty. */
type VaultFields = { user?: string; passphrase?: string; sudoPassword?: string };

const FIELD_KINDS: Record<keyof VaultFields, readonly VaultKind[]> = {
  user: ['ssh_key', 'login'],
  passphrase: ['ssh_key'],
  sudoPassword: ['ssh_key', 'login'],
};
const FIELD_NAME: Record<keyof VaultFields, string> = {
  user: 'user',
  passphrase: 'passphrase',
  sudoPassword: 'sudo_password',
};

/** A private key's armour: an OpenSSH or a PEM private key block. */
const SSH_KEY_RE =
  /^-----BEGIN ((?:OPENSSH|RSA|EC|DSA|ENCRYPTED) )?PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END \1?PRIVATE KEY-----\s*$/;

/** The shape a kind's value and fields must have; the reason never echoes
 *  a value. */
export function checkVaultShape(kind: VaultKind, value: string, fields: VaultFields): void {
  if (kind === 'ssh_key') {
    if (value.length > MAX_SSH_KEY || !SSH_KEY_RE.test(value.trim())) {
      throw new InputError(
        'value of an ssh_key must be a private key block (-----BEGIN OPENSSH PRIVATE KEY----- … -----END OPENSSH PRIVATE KEY-----, or a PEM one).',
      );
    }
  } else {
    if (!value) throw new InputError(`value of a ${kind} must not be empty.`);
    if (value.length > MAX_VALUE)
      throw new InputError(`value takes at most ${MAX_VALUE} characters.`);
    if (CONTROL_RE.test(value)) {
      throw new InputError('value must be one line with no control characters.');
    }
  }
  for (const k of Object.keys(FIELD_KINDS) as (keyof VaultFields)[]) {
    const v = fields[k];
    if (v === undefined) continue;
    if (!FIELD_KINDS[k].includes(kind)) {
      throw new InputError(
        `${FIELD_NAME[k]} belongs to ${FIELD_KINDS[k].join(' or ')}, not a ${kind}: pass ${FIELD_NAME[k]}: null to clear it.`,
      );
    }
    const max = k === 'user' ? MAX_USER : MAX_FIELD;
    if (v.length > max || CONTROL_RE.test(v) || (k === 'user' && /\s/.test(v))) {
      throw new InputError(
        `${FIELD_NAME[k]} must be at most ${max} characters, one line${k === 'user' ? ' with no spaces' : ''}.`,
      );
    }
  }
  if ((kind === 'login' || kind === 'ssh_key') && !fields.user) {
    throw new InputError(`a ${kind} needs user (the name it logs in as).`);
  }
}

// ── The gate and the reads ───────────────────────────────────────────────────

/** The one gate: the caller may do the Admin keys area, as Settings > Keys. */
async function gate(): Promise<void> {
  if (!(await callerHasArea('keys'))) throw new AccessError('area', undefined, { area: 'keys' });
}

function summary(row: ApiKey): VaultKeySummary {
  return {
    id: row.id,
    name: row.name ?? (row.label === 'default' ? row.service : `${row.service}/${row.label}`),
    kind: row.kind,
    service: row.service,
    label: row.label,
    target: row.target,
    tags: row.tags,
    needsApproval: row.needsApproval,
    viaTailnet: row.viaTailnet,
    masked: row.masked,
    anthropicWorkspaceId: row.anthropicWorkspaceId,
    lastUsed: row.lastUsed,
    useCount: row.useCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The row `ref` names of `ownerId`, or null; a name in the reserved
 *  connector namespace or that is no name refuses. */
async function findRow(ownerId: string, ref: VaultRef): Promise<ApiKey | null> {
  if ('id' in ref) {
    if (!UUID_RE.test(ref.id)) throw new InputError('id must be a key id from the key list.');
    const [row] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, ref.id), eq(apiKeys.userId, ownerId)))
      .limit(1);
    if (row && isMcpManagedSecretService(row.service)) return null;
    return row ?? null;
  }
  const parsed = parsedName(ref.name);
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.userId, ownerId),
        eq(apiKeys.service, parsed.service),
        eq(apiKeys.label, parsed.label),
      ),
    )
    .limit(1);
  return row ?? null;
}

function parsedName(raw: string): { service: string; label: string; name: string } {
  const parsed = parseVaultName(raw);
  if (!parsed) throw new InputError(`name is not a vault name: ${NAME_RULE}.`);
  if (isMcpManagedSecretService(parsed.service)) {
    throw new InputError(
      "names starting 'mcp-' hold MCP connector sign-ins and are managed under Settings → Connectors; pick another name.",
    );
  }
  return parsed;
}

/** The fields a row holds, opened in process for a merge or a shape check
 *  only. Never returned past this module. */
function openFields(row: ApiKey): VaultFields {
  if (!row.fieldsEnc) return {};
  const text = open(row.fieldsEnc, `${row.id}:fields`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A parse error quotes the text it read: never let it out.
    throw new Error('vault: the stored fields could not be read');
  }
  return parsed && typeof parsed === 'object' ? (parsed as VaultFields) : {};
}

function sealFields(id: string, fields: VaultFields): { fieldsEnc: Buffer | null } {
  const kept = Object.fromEntries(
    Object.entries(fields).filter(([, v]) => typeof v === 'string' && v.length > 0),
  );
  if (Object.keys(kept).length === 0) return { fieldsEnc: null };
  return { fieldsEnc: seal(JSON.stringify(kept), `${id}:fields`).ciphertext };
}

function maskFor(kind: VaultKind, value: string): string {
  return kind === 'token' ? maskPlaintext(value) : '••••';
}

/** A field as the input sets it: undefined keeps, null or '' clears. */
function merged(cur: string | undefined, next: string | null | undefined): string | undefined {
  if (next === undefined) return cur;
  return next === null || next === '' ? undefined : next;
}

// ── Set ──────────────────────────────────────────────────────────────────────

/** The checked plan of one set: what a write would send, or the refusal. */
type SetPlan =
  | {
      op: 'add';
      id: string;
      values: typeof apiKeys.$inferInsert;
      kind: VaultKind;
      name: string;
      changed: string[];
    }
  | {
      op: 'replace';
      row: ApiKey;
      set: Partial<typeof apiKeys.$inferInsert>;
      kind: VaultKind;
      changed: string[];
      secretReplaced: boolean;
    };

/** Check a set against the row it names (null: none, an add), with no
 *  write: the import checks every row before it writes one. */
function planSet(ownerId: string, input: VaultSetInput, row: ApiKey | null): SetPlan {
  if (input.kind !== undefined && !(VAULT_KINDS as readonly string[]).includes(input.kind)) {
    throw new InputError(`kind must be one of ${VAULT_KINDS.join(', ')}.`);
  }
  const target = input.target === undefined ? undefined : canonicalTargets(input.target);
  const tags = input.tags === undefined ? undefined : canonicalTags(input.tags);
  const workspace =
    input.anthropicWorkspaceId === undefined
      ? undefined
      : checkedWorkspaceId(input.anthropicWorkspaceId);
  const fieldInput = {
    user: input.user,
    passphrase: input.passphrase,
    sudoPassword: input.sudoPassword,
  };
  const fieldsGiven = Object.values(fieldInput).some((v) => v !== undefined);

  if (!row) {
    if (!('name' in input.ref)) throw new InputError('No such key: list them with api_key_refs.');
    const { service, label, name } = parsedName(input.ref.name);
    const kind = input.kind ?? 'token';
    if (input.value === undefined) {
      throw new InputError(
        'value is required: there is no key of that name yet, so this adds one.',
      );
    }
    const fields: VaultFields = {};
    for (const k of Object.keys(fieldInput) as (keyof VaultFields)[]) {
      const v = merged(undefined, fieldInput[k]);
      if (v !== undefined) fields[k] = v;
    }
    checkVaultShape(kind, input.value, fields);
    const finalTarget = target ?? [];
    if (kind !== 'token' && finalTarget.length === 0) {
      throw new InputError(
        `a ${kind} needs target: the hosts or origins it may be used on (e.g. ["printer-07.lan"]).`,
      );
    }
    if (workspace && (service !== 'anthropic' || kind !== 'token')) {
      throw new InputError('Only an Anthropic key can carry a workspace id.');
    }
    const id = randomUUID();
    const { ciphertext, keyVersion } = seal(input.value, id);
    return {
      op: 'add',
      id,
      kind,
      name,
      changed: ['value', ...(fieldsGiven ? ['fields'] : [])],
      values: {
        id,
        userId: ownerId,
        service,
        label,
        kind,
        keyEnc: ciphertext,
        keyVersion,
        masked: maskFor(kind, input.value),
        ...sealFields(id, fields),
        target: finalTarget,
        tags: tags ?? [],
        needsApproval: input.needsApproval ?? approvalDefault(kind),
        viaTailnet: input.viaTailnet ?? false,
        anthropicWorkspaceId: workspace ?? null,
      },
    };
  }

  const kind = input.kind ?? row.kind;
  const kindChanged = kind !== row.kind;
  if (kindChanged && input.value === undefined) {
    throw new InputError(`value is required to change the kind (it is a ${row.kind} now).`);
  }
  const set: Partial<typeof apiKeys.$inferInsert> = {};
  const changed: string[] = [];
  let secretReplaced = false;
  if (kindChanged) {
    set.kind = kind;
    changed.push('kind');
  }
  // The fields: merged over what the row holds (opened here only), checked
  // with the value they go with.
  const cur = kindChanged || fieldsGiven || input.value !== undefined ? openFields(row) : {};
  const fields: VaultFields = {};
  for (const k of Object.keys(fieldInput) as (keyof VaultFields)[]) {
    const v = merged(cur[k], fieldInput[k]);
    if (v !== undefined) fields[k] = v;
  }
  if (input.value !== undefined) {
    checkVaultShape(kind, input.value, fields);
    const { ciphertext, keyVersion } = seal(input.value, row.id);
    set.keyEnc = ciphertext;
    set.keyVersion = keyVersion;
    set.masked = maskFor(kind, input.value);
    changed.push('value');
    secretReplaced = true;
  } else if (fieldsGiven) {
    // A field changed with the stored value: the shape of the fields alone.
    checkVaultShape(kind, kind === 'ssh_key' ? sshShapeStandIn : 'x', fields);
  }
  if (fieldsGiven || kindChanged) {
    Object.assign(set, sealFields(row.id, fields));
    changed.push('fields');
    secretReplaced = true;
  }
  const finalTarget = target ?? row.target;
  if (target !== undefined) {
    set.target = target;
    changed.push('target');
  }
  if (kind !== 'token' && finalTarget.length === 0) {
    throw new InputError(
      `a ${kind} needs target: the hosts or origins it may be used on (e.g. ["printer-07.lan"]).`,
    );
  }
  if (tags !== undefined) {
    set.tags = tags;
    changed.push('tags');
  }
  // Approval: as the caller says; else a kind change keeps it on if it was
  // on, and turns it on where the new kind's default is on. Never off by
  // itself.
  if (input.needsApproval !== undefined) {
    set.needsApproval = input.needsApproval;
  } else if (kindChanged) {
    set.needsApproval = row.needsApproval || approvalDefault(kind);
  }
  if (set.needsApproval !== undefined && set.needsApproval !== row.needsApproval) {
    changed.push('needs_approval');
  }
  if (input.viaTailnet !== undefined && input.viaTailnet !== row.viaTailnet) {
    set.viaTailnet = input.viaTailnet;
    changed.push('via_tailnet');
  }
  if (workspace !== undefined) {
    if (workspace && (row.service !== 'anthropic' || kind !== 'token')) {
      throw new InputError('Only an Anthropic key can carry a workspace id.');
    }
    if (workspace !== row.anthropicWorkspaceId) {
      set.anthropicWorkspaceId = workspace;
      changed.push('anthropic_workspace_id');
    }
  } else if (kindChanged && kind !== 'token' && row.anthropicWorkspaceId) {
    set.anthropicWorkspaceId = null;
    changed.push('anthropic_workspace_id');
  }
  return { op: 'replace', row, set, kind, changed, secretReplaced };
}

/** Stands in for a stored SSH key when only its fields change: the key's
 *  own shape was checked when it was set. */
const sshShapeStandIn =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nstored\n-----END OPENSSH PRIVATE KEY-----';

async function writePlan(plan: SetPlan): Promise<ApiKey> {
  if (plan.op === 'replace' && plan.changed.length === 0) return plan.row;
  const set = plan.op === 'replace' ? { ...plan.set, updatedAt: new Date() } : {};
  const write = () =>
    plan.op === 'add'
      ? db.insert(apiKeys).values(plan.values).returning()
      : db.update(apiKeys).set(set).where(eq(apiKeys.id, plan.row.id)).returning();
  // The full-route spot model-route (where a vault key goes): a key made
  // is not the narrow login's (access-matrix.ts NARROW_NEVER_INSERT: its
  // seal binds its id only), and neither is a kind, target, approval, tags,
  // tailnet or fields change (0346); a new value alone (key_enc, masked) is.
  const atSpot = plan.op === 'add' || narrowNeedsSpot(apiKeys, 'update', set);
  const [row] = await conflictOnUnique(
    'A key of that name was saved at the same moment: list the keys and try again.',
    () => (atSpot ? onFullSystemRoute('model-route', write) : write()),
  );
  if (!row) throw new Error(`failed to ${plan.op === 'add' ? 'insert' : 'update'} api_key`);
  return row;
}

async function audit(
  who: VaultActor,
  action: 'vault.key.set' | 'vault.key.delete' | 'vault.key.test',
  detail: Record<string, unknown>,
): Promise<void> {
  // The trail never fails the write it records (already made): logged.
  // `db`, as the write: the area's system pool after the gate (an area
  // route, an area tool run whole on the system pool), where audit_log
  // takes an insert.
  await db
    .insert(auditLog)
    .values({
      actorId: who.loginId,
      actorEmail: who.email ?? `owner (${who.via})`,
      action,
      detail: { ...detail, via: who.via },
    })
    .catch((err: unknown) => {
      log('vault').error(`failed to record ${action}:`, err);
    });
}

/** Add or replace one secret. Throws InputError (the caller hears 400 and
 *  the reason) or ConflictError (409). Null: `ref` is an id that names no
 *  key of this owner. */
export async function setVaultKey(
  who: VaultActor,
  ownerId: string,
  input: VaultSetInput,
): Promise<VaultSetResult | null> {
  // Pure checks first, so a refusal costs no database work (planSet runs
  // them again with the row).
  if ('name' in input.ref) parsedName(input.ref.name);
  if (input.kind !== undefined && !(VAULT_KINDS as readonly string[]).includes(input.kind)) {
    throw new InputError(`kind must be one of ${VAULT_KINDS.join(', ')}.`);
  }
  if (input.target !== undefined) canonicalTargets(input.target);
  if (input.tags !== undefined) canonicalTags(input.tags);
  if (input.anthropicWorkspaceId !== undefined) checkedWorkspaceId(input.anthropicWorkspaceId);
  await gate();
  const row = await findRow(ownerId, input.ref);
  if (!row && 'id' in input.ref) return null;
  const plan = planSet(ownerId, input, row);
  return commitPlan(who, plan);
}

async function commitPlan(who: VaultActor, plan: SetPlan): Promise<VaultSetResult> {
  const written = await writePlan(plan);
  const key = summary(written);
  if (plan.changed.length > 0) {
    await audit(who, 'vault.key.set', {
      keyId: key.id,
      name: key.name,
      kind: key.kind,
      op: plan.op,
      changed: plan.changed,
    });
  }
  return { key, op: plan.op, secretWritten: plan.op === 'add' || plan.secretReplaced };
}

// ── Delete ───────────────────────────────────────────────────────────────────

/** Delete one secret; its summary, or null when `ref` names none. */
export async function deleteVaultKey(
  who: VaultActor,
  ownerId: string,
  ref: VaultRef,
): Promise<VaultKeySummary | null> {
  if ('name' in ref) parsedName(ref.name);
  await gate();
  const row = await findRow(ownerId, ref);
  if (!row) return null;
  const [gone] = await db
    .delete(apiKeys)
    .where(and(eq(apiKeys.id, row.id), eq(apiKeys.userId, ownerId)))
    .returning();
  if (!gone) return null;
  const key = summary(gone);
  await audit(who, 'vault.key.delete', { keyId: key.id, name: key.name, kind: key.kind });
  return key;
}

// ── Test ─────────────────────────────────────────────────────────────────────

/**
 * Test one secret. A token: the provider probe Settings > Keys has always
 * run (probe.ts, its message scrubbed of the key). Any other kind: the
 * stored shape only, opened in process (part 3 logs in). Null: no such key.
 */
export async function testVaultKey(
  who: VaultActor,
  ownerId: string,
  ref: VaultRef,
): Promise<VaultTestResult | null> {
  if ('name' in ref) parsedName(ref.name);
  await gate();
  const row = await findRow(ownerId, ref);
  if (!row) return null;
  const key = summary(row);
  let result: TestApiKeyResult;
  if (row.kind === 'token') {
    result = await probeApiKey(row.id, row.service);
  } else {
    let message: string;
    let ok = true;
    try {
      checkVaultShape(row.kind, open(row.keyEnc, row.id), openFields(row));
      message = `The stored ${KIND_LABEL[row.kind].toLowerCase()} has the right shape. Logging in to the target is not tested yet.`;
    } catch (err) {
      ok = false;
      message =
        err instanceof InputError
          ? `The stored ${KIND_LABEL[row.kind].toLowerCase()} is not usable: ${err.message} Set it again with api_key_set.`
          : 'The stored value could not be opened (a different MANTLE_MASTER_KEY?). Set it again.';
    }
    result = { ok, message, provider: KIND_LABEL[row.kind], adapter: '' };
  }
  await audit(who, 'vault.key.test', {
    keyId: key.id,
    name: key.name,
    kind: key.kind,
    ok: result.ok,
  });
  return { ...result, name: key.name, kind: key.kind };
}

// ── Import ───────────────────────────────────────────────────────────────────

/** The columns of an import, in order (a header row naming them is
 *  skipped). */
export const VAULT_IMPORT_COLUMNS = ['name', 'kind', 'target', 'user', 'secret', 'tags'] as const;

/**
 * Parse CSV text (RFC 4180: quoted cells, "" inside quotes, CRLF or LF; a
 * quoted cell may span lines, as an SSH key does) into rows of cells.
 * Throws InputError naming the row of an unclosed quote.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowStart = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (c === '\n') line++;
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      line++;
      rowStart = line;
    } else cell += c;
  }
  if (quoted) throw new InputError(`row ${rowStart}: a quoted cell is never closed.`);
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** A list cell of an import (targets, tags): split on ';' or spaces. */
function listCell(cell: string): string[] {
  return cell
    .split(/[;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Import secrets from CSV: name, kind, target, user, secret, tags (targets
 * and tags split on ';' or spaces; an empty kind is a token). Every row is
 * checked first; one bad row and nothing is written, and each bad row is
 * named with the reason (never a cell's content). A row whose name exists
 * replaces it, as a set does.
 */
export async function importVaultKeys(
  who: VaultActor,
  ownerId: string,
  csv: string,
): Promise<VaultImportResult> {
  const rows = parseCsv(csv);
  const header = rows[0]?.map((c) => c.trim().toLowerCase());
  const body = header && header[0] === 'name' && header[4] === 'secret' ? rows.slice(1) : rows;
  const offset = rows.length - body.length;
  if (body.length === 0)
    throw new InputError('The CSV has no rows: name,kind,target,user,secret,tags.');
  if (body.length > VAULT_IMPORT_MAX_ROWS) {
    throw new InputError(`The CSV has more than ${VAULT_IMPORT_MAX_ROWS} rows: split it.`);
  }
  await gate();
  const failed: { row: number; reason: string }[] = [];
  const plans: SetPlan[] = [];
  const seen = new Set<string>();
  for (const [i, cells] of body.entries()) {
    const rowNo = i + 1 + offset;
    try {
      if (cells.length > VAULT_IMPORT_COLUMNS.length) {
        throw new InputError(
          `${cells.length} columns, at most ${VAULT_IMPORT_COLUMNS.length} (name,kind,target,user,secret,tags); quote a cell that holds a comma.`,
        );
      }
      const [name = '', kind = '', target = '', user = '', secret = '', tags = ''] = cells;
      const parsed = parseVaultName(name);
      if (!parsed) throw new InputError(`the name column is not a vault name: ${NAME_RULE}.`);
      if (seen.has(parsed.name)) throw new InputError('the same name is on an earlier row.');
      seen.add(parsed.name);
      const k = kind.trim().toLowerCase() || 'token';
      if (!(VAULT_KINDS as readonly string[]).includes(k)) {
        throw new InputError(`the kind column must be one of ${VAULT_KINDS.join(', ')}.`);
      }
      if (!secret) throw new InputError('the secret column is empty.');
      const input: VaultSetInput = {
        ref: { name: parsed.name },
        kind: k as VaultKind,
        value: k === 'ssh_key' ? secret : secret.trim(),
        ...(user.trim() ? { user: user.trim() } : {}),
        ...(target.trim() ? { target: listCell(target) } : {}),
        ...(tags.trim() ? { tags: listCell(tags) } : {}),
      };
      parsedName(parsed.name);
      plans.push(planSet(ownerId, input, await findRow(ownerId, input.ref)));
    } catch (err) {
      if (!(err instanceof InputError)) throw err;
      failed.push({ row: rowNo, reason: err.message });
    }
  }
  if (failed.length > 0) return { ok: false, failed };
  const keys: VaultSetResult[] = [];
  for (const plan of plans) keys.push(await commitPlan(who, plan));
  return {
    ok: true,
    added: keys.filter((k) => k.op === 'add').length,
    replaced: keys.filter((k) => k.op === 'replace').length,
    keys,
  };
}
