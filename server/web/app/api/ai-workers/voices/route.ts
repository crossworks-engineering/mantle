import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { listVoices } from '@/lib/ai-worker-rpc';

const Body = z.object({
  apiKeyId: z.string(),
  providerId: z.string().min(1),
  modelId: z.string(),
});

/** List the voices available for a tts provider + model (live for ElevenLabs). */
export async function POST(req: Request) {
  const gate = await getOwnerOr401();
  if (gate instanceof Response) return gate;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  const { apiKeyId, providerId, modelId } = parsed.data;
  return NextResponse.json(await listVoices(apiKeyId, providerId, modelId));
}
