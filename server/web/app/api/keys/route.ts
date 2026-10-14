import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { listApiKeys, setApiKey } from '@/lib/api-keys';
import { afterVaultKeyReplaced } from '@/lib/mcp-connectors';
import { KNOWN_KEY_SERVICES } from '@mantle/api-keys';
import { isMcpManagedSecretService } from '@mantle/tools';
import { firstIssue } from '@/lib/zod-issue';
import { conflictOnUnique } from '@mantle/db';
import { readJson } from '@/lib/read-body';

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
  return NextResponse.json({ keys, knownServices });
}

const CreateBody = z.object({
  service: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/i, 'service must be alphanumeric'),
  label: z.string().min(1).max(64).default('default'),
  plaintext: z.string().min(1).max(8192),
});

export async function POST(req: Request) {
  const user = ownerCaller();
  const raw = await readJson(req);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    const message = firstIssue(parsed.error, 'Invalid input.');
    return NextResponse.json({ error: message }, { status: 400 });
  }
  // A slug or name taken answers 409 with this route's own text
  // (conflictOnUnique, a ConflictError); anything else answers by the one
  // table (A10 part 2): a domain error its status, a fault the opaque 500.
  return conflictOnUnique(
    `A key already exists for ${parsed.data.service}/${parsed.data.label}. Rotate it instead.`,
    async () => {
      const row = await setApiKey(
        user.id,
        parsed.data.service,
        parsed.data.label,
        parsed.data.plaintext,
      );
      // A save over an existing key replaces it, as a rotate does (access
      // matrix T7): a connector's marks were for the old key.
      await afterVaultKeyReplaced(user.id, row.service, row.label);
      return NextResponse.json({
        id: row.id,
        service: row.service,
        label: row.label,
        createdAt: row.createdAt,
      });
    },
  );
}
