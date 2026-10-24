import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { createOpenapiConnector, integrationPairing, vaultPairLoginRefusal } from '@mantle/tools';
import { listOpenapiConnectors } from '@/lib/openapi-connectors';
import { toolMakerFor } from '@/lib/tools';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'connectors' },
  POST: {
    class: 'area',
    area: 'connectors',
    item: { none: 'manages the connectors area: the Admin step checks it' },
  },
});

/** OpenAPI connectors: a service's OpenAPI 3.x spec consumed as a
 *  per-connector tool group of ordinary http tools. GET lists connected
 *  specs plus the known-APIs catalog (placeholder rows for the settings UI);
 *  POST creates a connector and runs its first sync. See
 *  docs/openapi-connectors.md. */

export async function GET() {
  const user = ownerCaller();
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
  const user = ownerCaller();
  const raw = await readJson(req);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  // A connector whose auth carries a vault key sends it to its base URL (or
  // the spec's server): pairing the two is the keys area's (W7a fix round 4,
  // @mantle/tools secret-ref-gate.ts). The connector records who paired them.
  const configuredBy = toolMakerFor(user);
  const pairing = integrationPairing({
    ...parsed.data,
    openapi: { specUrl: parsed.data.specUrl },
  });
  if (pairing.key) {
    const refused = await vaultPairLoginRefusal(configuredBy);
    if (refused) return NextResponse.json({ error: refused }, { status: 403 });
  }
  // A binding the connector refuses (InputError) answers 400 by the one table
  // (A10 part 2); a failed first sync is the result's syncError; a fault the
  // opaque 500.
  const result = await createOpenapiConnector(user.id, { ...parsed.data, configuredBy });
  return NextResponse.json(result, { status: 201 });
}
