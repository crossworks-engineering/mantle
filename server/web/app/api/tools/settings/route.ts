import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { loadProfilePreferences, updateProfilePreferences } from '@mantle/content';
import type { ToolSettings } from '@mantle/client-types';
import { ownerCaller } from '@/lib/auth';
import { readBody } from '@/lib/read-body';
import { feature } from '@mantle/config';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'area', area: 'assistants' },
  PUT: {
    class: 'area',
    area: 'assistants',
    item: { none: 'manages the assistants area: the Admin step checks it' },
  },
});

/** The two owner-level tool policy toggles (stored in profile preferences):
 *  agent-built-tool approval, and the unattended-heartbeat email/web egress gate. */
export async function GET() {
  const user = ownerCaller();
  const prefs = await loadProfilePreferences(user.id);
  const body: ToolSettings = {
    requireApproval: feature('toolsmithRequireApproval', { prefs }),
    egressGate: feature('heartbeatEgressGate', { prefs }),
  };
  return NextResponse.json(body);
}

const PatchBody = z
  .object({ requireApproval: z.boolean().optional(), egressGate: z.boolean().optional() })
  .refine(
    (b) => b.requireApproval !== undefined || b.egressGate !== undefined,
    'nothing to update',
  );

export async function PUT(req: Request) {
  const user = ownerCaller();
  const input = await readBody(req, PatchBody);
  await updateProfilePreferences(user.id, {
    ...(input.requireApproval !== undefined
      ? { toolsmithRequireApproval: input.requireApproval }
      : {}),
    ...(input.egressGate !== undefined ? { heartbeatEgressGate: input.egressGate } : {}),
  });
  const prefs = await loadProfilePreferences(user.id);
  const body: ToolSettings = {
    requireApproval: feature('toolsmithRequireApproval', { prefs }),
    egressGate: feature('heartbeatEgressGate', { prefs }),
  };
  return NextResponse.json(body);
}
