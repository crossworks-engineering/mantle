import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { discoverModels } from '@/lib/ai-worker-rpc';

const Body = z.object({
  apiKeyId: z.string(),
  kind: z.enum(['tts', 'stt', 'chat', 'vision', 'image_gen', 'embedding']),
  providerId: z.string().min(1),
});

/** List the models a given api key can access — narrows the form's dropdown. */
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
  const { apiKeyId, kind, providerId } = parsed.data;
  return NextResponse.json(await discoverModels(apiKeyId, kind, providerId));
}
