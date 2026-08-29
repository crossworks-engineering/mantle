import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { createMcpConnector } from '@mantle/tools';
import { listMcpConnectors } from '@/lib/mcp-connectors';

/** MCP connectors: external MCP servers consumed as per-connector tool
 *  groups. GET lists connected servers plus the known-servers catalog
 *  (placeholder rows for the settings UI); POST creates a connector and runs
 *  its first sync. See docs/mcp-connectors.md. */

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const result = await listMcpConnectors(user.id);
  return NextResponse.json(result);
}

const CreateBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters/digits/dash/underscore'),
  name: z.string().max(120).optional(),
  url: z.string().min(1).max(2000),
  secretRef: z.string().max(160).optional(),
  authHeader: z.string().max(64).optional(),
  authScheme: z.string().max(20).optional(),
});

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const raw = await req.json().catch(() => ({}));
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const result = await createMcpConnector(user.id, parsed.data);
    // A created-but-unsynced connector is still a success: the group exists,
    // the caller fixes the config (or the server comes back) and re-syncs.
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = msg.includes('already exists') ? 409 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
