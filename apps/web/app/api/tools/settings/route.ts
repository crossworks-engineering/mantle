import { NextResponse } from 'next/server';
import { z } from 'zod';
import { loadProfilePreferences, updateProfilePreferences } from '@mantle/content';
import type { ToolSettings } from '@mantle/client-types';
import { getOwnerOr401 } from '@/lib/auth';

/** The two owner-level tool policy toggles (stored in profile preferences):
 *  agent-built-tool approval, and the unattended-heartbeat email/web egress gate. */
export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const prefs = await loadProfilePreferences(user.id);
  const body: ToolSettings = {
    requireApproval: prefs.toolsmithRequireApproval === true,
    egressGate: prefs.heartbeatEgressGate === true,
  };
  return NextResponse.json(body);
}

const PatchBody = z
  .object({ requireApproval: z.boolean().optional(), egressGate: z.boolean().optional() })
  .refine((b) => b.requireApproval !== undefined || b.egressGate !== undefined, 'nothing to update');

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid input' },
      { status: 400 },
    );
  }
  await updateProfilePreferences(user.id, {
    ...(parsed.data.requireApproval !== undefined
      ? { toolsmithRequireApproval: parsed.data.requireApproval }
      : {}),
    ...(parsed.data.egressGate !== undefined ? { heartbeatEgressGate: parsed.data.egressGate } : {}),
  });
  const prefs = await loadProfilePreferences(user.id);
  const body: ToolSettings = {
    requireApproval: prefs.toolsmithRequireApproval === true,
    egressGate: prefs.heartbeatEgressGate === true,
  };
  return NextResponse.json(body);
}
