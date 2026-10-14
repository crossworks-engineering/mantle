import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { discoverModels } from '@/lib/ai-worker-rpc';
import { readBody } from '@/lib/read-body';

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
  return NextResponse.json(await discoverModels(apiKeyId, kind, providerId));
}
