import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { listVoices } from '@/lib/ai-worker-rpc';
import { firstIssue } from '@/lib/zod-issue';

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
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const { apiKeyId, providerId, modelId } = parsed.data;
  return NextResponse.json(await listVoices(apiKeyId, providerId, modelId));
}
