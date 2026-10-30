import { NextResponse } from '@/server/http-compat';
import { modelPolicyRefusal, modelPolicySet } from '@mantle/config';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { discoverModels } from '@/lib/ai-worker-rpc';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

const Body = z.object({
  apiKeyId: z.string(),
  kind: z.enum(['tts', 'stt', 'chat', 'vision', 'image_gen', 'embedding']),
  providerId: z.string().min(1),
});

/** List the models a given api key can access — narrows the form's dropdown. */
export async function POST(req: Request) {
  ownerCaller();
  const body = await readBody(req, Body);
  const { apiKeyId, kind, providerId } = body;
  const found = await discoverModels(apiKeyId, kind, providerId);
  // The box policy's model block (docs/policy.md): a pick list never offers
  // a blocked model. With no model rule, the list as found.
  if (!modelPolicySet()) return NextResponse.json(found);
  return NextResponse.json({
    ...found,
    available: found.available.filter((m) => modelPolicyRefusal(providerId, m.id) === null),
  });
}
