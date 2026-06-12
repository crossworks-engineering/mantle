/**
 * API Console ↔ MCP bridge. GET lists the live tool catalog from the
 * spawned apps/mcp server; POST invokes one tool. Owner-gated — this is
 * the same data surface the MCP server already exposes over stdio.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { callMcpTool, listMcpTools } from '@/lib/dev-tools/mcp-bridge';

export const dynamic = 'force-dynamic';

export async function GET() {
  await requireOwner();
  try {
    const tools = await listMcpTools();
    return NextResponse.json({ tools });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `MCP server unavailable: ${msg}` },
      { status: 503 },
    );
  }
}

const CallBody = z.object({
  name: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()).default({}),
});

export async function POST(req: Request) {
  await requireOwner();
  const raw = await req.json().catch(() => ({}));
  const parsed = CallBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  try {
    const result = await callMcpTool(parsed.data.name, parsed.data.args);
    return NextResponse.json({ result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
