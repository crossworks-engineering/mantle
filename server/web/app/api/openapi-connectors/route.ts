import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { createOpenapiConnector } from '@mantle/tools';
import { listOpenapiConnectors } from '@/lib/openapi-connectors';

/** OpenAPI connectors: a service's OpenAPI 3.x spec consumed as a
 *  per-connector tool group of ordinary http tools. GET lists connected
 *  specs plus the known-APIs catalog (placeholder rows for the settings UI);
 *  POST creates a connector and runs its first sync. See
 *  docs/openapi-connectors.md. */

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const result = await listOpenapiConnectors(user.id);
  return NextResponse.json(result);
}

const AuthTemplate = z
  .object({
    headers: z.record(z.string().min(1).max(64), z.string().max(500)).optional(),
    query: z.record(z.string().min(1).max(64), z.string().max(500)).optional(),
  })
  .optional();

const CreateBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters/digits/dash/underscore'),
  name: z.string().max(120).optional(),
  specUrl: z.string().min(1).max(2000),
  service: z.string().max(64).optional(),
  baseUrl: z.string().max(2000).optional(),
  secretRef: z.string().max(160).optional(),
  authTemplate: AuthTemplate,
  selection: z
    .object({
      tags: z.array(z.string().min(1).max(200)).max(40).optional(),
      operations: z.array(z.string().min(1).max(200)).max(200).optional(),
    })
    .optional(),
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
    const result = await createOpenapiConnector(user.id, parsed.data);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}
