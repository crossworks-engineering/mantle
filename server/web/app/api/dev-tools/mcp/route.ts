/**
 * API Console ↔ MCP bridge. GET lists the live tool catalog from the
 * spawned server/mcp server; POST invokes one tool. Owner-gated — this is
 * the same data surface the MCP server already exposes over stdio.
 *
 * The stdio server runs as the brain owner's login (server/mcp
 * stdio-actor.ts), its scope and its per-login items, so a call through
 * the bridge is the owner login's alone: any other Admin user is refused
 * (403) and runs a tool in its own scope through the console's tool runner
 * (execute-tool) or its own MCP client instead. The catalog lists for all.
 */

import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { callMcpTool, listMcpTools } from '@/lib/dev-tools/mcp-bridge';
import { errorMessage } from '@mantle/std';
import { firstIssue } from '@/lib/zod-issue';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'settings' },
  POST: {
    class: 'area',
    area: 'settings',
    item: { none: 'manages the settings area: the Admin step checks it' },
  },
});

export async function GET() {
  ownerCaller();
  try {
    const tools = await listMcpTools();
    return NextResponse.json({ tools });
  } catch (err) {
    const msg = errorMessage(err);
    return NextResponse.json({ error: `MCP server unavailable: ${msg}` }, { status: 503 });
  }
}

const CallBody = z.object({
  name: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()).default({}),
});

/** The bridge's call refusal for a login that is not the brain owner's. */
export const BRIDGE_NOT_YOURS =
  "The console's MCP bridge runs as the brain owner's login. Run the tool from the tool list instead (it runs as you), or connect your own MCP client.";

export async function POST(req: Request) {
  const user = ownerCaller();
  if (user.actor.id.toLowerCase() !== user.id.toLowerCase()) {
    return NextResponse.json({ error: BRIDGE_NOT_YOURS }, { status: 403 });
  }
  const raw = await readJson(req);
  const parsed = CallBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  try {
    const result = await callMcpTool(parsed.data.name, parsed.data.args);
    return NextResponse.json({ result });
  } catch (err) {
    const msg = errorMessage(err);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
