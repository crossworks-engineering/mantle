import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { listVoices } from '@/lib/ai-worker-rpc';
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
  providerId: z.string().min(1),
  modelId: z.string(),
});

/** List the voices available for a tts provider + model (live for ElevenLabs). */
export async function POST(req: Request) {
  ownerCaller();
  const body = await readBody(req, Body);
  const { apiKeyId, providerId, modelId } = body;
  return NextResponse.json(await listVoices(apiKeyId, providerId, modelId));
}
