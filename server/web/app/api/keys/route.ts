import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { listApiKeys, setApiKey } from '@/lib/api-keys';
import { KNOWN_KEY_SERVICES } from '@mantle/api-keys';
import { isMcpManagedSecretService } from '@mantle/tools';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid input.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
  try {
    const row = await setApiKey(
      user.id,
      parsed.data.service,
      parsed.data.label,
      parsed.data.plaintext,
    );
    return NextResponse.json({
      id: row.id,
      service: row.service,
      label: row.label,
      createdAt: row.createdAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 23505 = unique_violation
    if (msg.includes('api_keys_user_service_label_uq') || msg.includes('duplicate key')) {
      return NextResponse.json(
        {
          error: `A key already exists for ${parsed.data.service}/${parsed.data.label}. Rotate it instead.`,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
