import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { runAssistantTurn } from '@/lib/assistant';

const Body = z.object({ text: z.string().min(1).max(20_000) });

export async function POST(req: Request) {
  const user = await requireOwner();
  const raw = await req.json().catch(() => ({}));
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const { inbound, outbound, reply, artifacts } = await runAssistantTurn(
      user.id,
      parsed.data.text,
    );
    return NextResponse.json({
      inbound: {
        id: inbound.id,
        text: inbound.text,
        createdAt: inbound.createdAt.toISOString(),
      },
      outbound: {
        id: outbound.id,
        text: outbound.text,
        model: outbound.model,
        createdAt: outbound.createdAt.toISOString(),
      },
      reply,
      // Sidecar artifacts from worker tools (audio bytes from
      // synthesize_speech, image bytes from generate_image). The
      // client renders them inline in the outbound bubble.
      artifacts,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[assistant/turn]', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
