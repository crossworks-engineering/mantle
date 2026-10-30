import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { listApiKeys, setVaultKey, vaultActor, vaultKeyReply } from '@/lib/api-keys';
import { afterVaultKeyReplaced } from '@/lib/mcp-connectors';
import { retryProvidersAfterKeyChange } from '@/lib/embedding-config';
import { KNOWN_KEY_SERVICES, VAULT_KINDS } from '@mantle/api-keys';
import { isMcpManagedSecretService } from '@mantle/tools';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'keys' },
  POST: {
    class: 'area',
    area: 'keys',
    item: { none: 'manages the keys area: the Admin step checks it' },
  },
});

export async function GET() {
  const user = ownerCaller();
  // Rows under the reserved 'mcp-' namespace are connector-sealed OAuth state
  // (tokens, registrations) written by the MCP connector flow, not keys the
  // owner typed in. They are hidden here — deleting one from the keys screen
  // would break a connector while it still claims connected; the connector's
  // own delete purges them.
  const keys = (await listApiKeys(user.id)).filter((k) => !isMcpManagedSecretService(k.service));
  // Known non-LLM services ride along so the UI can show an empty
  // placeholder row per unconfigured service (discoverability — the user
  // shouldn't need to know the slug to learn the capability exists).
  const configured = new Set(keys.map((k) => k.service));
  const knownServices = KNOWN_KEY_SERVICES.map((s) => ({
    ...s,
    configured: configured.has(s.service),
  }));
  // What this brain's key form can carry, so a newer UI shows a field only
  // where the brain stores it (an older brain sends no `features`).
  const features = { anthropicWorkspaceId: true, vaultKinds: [...VAULT_KINDS], csvImport: true };
  return NextResponse.json({ keys, knownServices, features });
}

const CreateBody = z
  .object({
    /** The name agents say (printer-07, openrouter/agent); or the older
     *  form, service and label. */
    name: z.string().min(1).max(130).optional(),
    service: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]+$/i, 'service must be alphanumeric')
      .optional(),
    label: z.string().min(1).max(64).default('default'),
    kind: z.enum(VAULT_KINDS).optional(),
    /** The secret: a token, a password or an SSH private key. `plaintext`
     *  is the older form's name for it. */
    value: z.string().min(1).max(16384).optional(),
    plaintext: z.string().min(1).max(8192).optional(),
    user: z.string().max(256).nullable().optional(),
    passphrase: z.string().max(1024).nullable().optional(),
    sudoPassword: z.string().max(1024).nullable().optional(),
    target: z.array(z.string().max(300)).max(32).optional(),
    tags: z.array(z.string().max(40)).max(20).optional(),
    needsApproval: z.boolean().optional(),
    viaTailnet: z.boolean().optional(),
    /** Anthropic keys only: the workspace id a key not scoped to a workspace
     *  names on every call. Optional; checked in @mantle/api-keys (a 400 for
     *  another service or a shape that could never be a header value). */
    anthropicWorkspaceId: z.string().max(256).nullable().optional(),
  })
  .refine((b) => (b.name === undefined) !== (b.service === undefined), {
    message: 'Send name, or service and label.',
  })
  .refine((b) => b.value === undefined || b.plaintext === undefined, {
    message: 'Send the secret once, as value.',
  });

/** Add a secret, or replace the one of that name (the vault's write
 *  gateway: its gate, its checks, its audit row). Never answers a value. */
export async function POST(req: Request) {
  const user = ownerCaller();
  const parsed = CreateBody.safeParse(await readJson(req));
  if (!parsed.success) {
    const message = firstIssue(parsed.error, 'Invalid input.');
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const b = parsed.data;
  const name = b.name ?? (b.label === 'default' ? b.service! : `${b.service}/${b.label}`);
  const value = b.value ?? b.plaintext;
  const result = await setVaultKey(vaultActor(user), user.id, {
    ref: { name },
    ...(b.kind !== undefined ? { kind: b.kind } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(b.user !== undefined ? { user: b.user } : {}),
    ...(b.passphrase !== undefined ? { passphrase: b.passphrase } : {}),
    ...(b.sudoPassword !== undefined ? { sudoPassword: b.sudoPassword } : {}),
    ...(b.target !== undefined ? { target: b.target } : {}),
    ...(b.tags !== undefined ? { tags: b.tags } : {}),
    ...(b.needsApproval !== undefined ? { needsApproval: b.needsApproval } : {}),
    ...(b.viaTailnet !== undefined ? { viaTailnet: b.viaTailnet } : {}),
    ...(b.anthropicWorkspaceId !== undefined
      ? { anthropicWorkspaceId: b.anthropicWorkspaceId }
      : {}),
  });
  // A set by name always finds or makes its row.
  const { key, secretWritten } = result!;
  // A new or replaced secret: a connector's marks were for the old one
  // (access matrix T7).
  if (secretWritten) await afterVaultKeyReplaced(user.id, key.service, key.label);
  // A new or replaced model provider key: an open provider alert (a
  // refused key, no key) probes now (no alert open, nothing is sent).
  if (secretWritten) await retryProvidersAfterKeyChange(user.id, key.service);
  return NextResponse.json(vaultKeyReply(key));
}
