import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { deleteAgent, updateAgent } from '@/lib/agents';

const IdParams = z.object({ id: z.string().uuid() });

const RoleEnum = z.enum([
  'assistant',
  'responder',
  'extractor',
  'summarizer',
  'reflector',
  'custom',
]);

const MemoryConfig = z
  .object({
    history_limit: z.number().int().min(0).max(500).optional(),
    history_window_hours: z.number().min(0).max(24 * 365).nullable().optional(),
    digest_limit: z.number().int().min(0).max(20).optional(),
    summarize_threshold: z.number().int().min(1).max(10_000).optional(),
    summarize_batch: z.number().int().min(1).max(1_000).optional(),
  })
  .strict();

const Params = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().min(1).max(1_000_000).optional(),
    top_p: z.number().min(0).max(1).optional(),
  })
  .strict();

const PatchBody = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(2000).nullable(),
    role: RoleEnum,
    model: z.string().min(1).max(200),
    apiKeyId: z.string().uuid().nullable(),
    systemPrompt: z.string().min(1).max(40_000),
    tools: z.array(z.string()).max(64),
    memoryConfig: MemoryConfig,
    params: Params,
    priority: z.number().int().min(0).max(1_000_000),
    enabled: z.boolean(),
  })
  .partial();

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const raw = await req.json().catch(() => ({}));
  const parsed = PatchBody.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? 'Invalid input.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
  const row = await updateAgent(user.id, idParsed.data.id, parsed.data);
  if (!row) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ agent: row });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const ok = await deleteAgent(user.id, idParsed.data.id);
  if (!ok) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
