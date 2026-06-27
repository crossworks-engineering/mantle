/**
 * /api/agents/[id]/persona — human curation of an agent's persona notes
 * (Layer-1 "what it has learned"). The reflector + update_persona tool write
 * these automatically; this endpoint lets the operator add/edit/retire/restore
 * from /settings/agents. All ops go through the soft-retire helpers in
 * lib/agents, so nothing is ever hard-deleted.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import {
  addPersonaNote,
  editPersonaNote,
  restorePersonaNote,
  retirePersonaNote,
} from '@/lib/agents';

const IdParams = z.object({ id: z.string().uuid() });
const Kind = z.enum(['style', 'relationship', 'correction']);

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), kind: Kind, content: z.string().min(1).max(2000) }),
  z.object({
    action: z.literal('edit'),
    ref: z.string().min(1).max(200),
    kind: Kind,
    content: z.string().min(1).max(2000),
  }),
  z.object({ action: z.literal('retire'), ref: z.string().min(1).max(200) }),
  z.object({ action: z.literal('restore'), ref: z.string().min(1).max(200) }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) {
    return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input.' },
      { status: 400 },
    );
  }
  const id = idParsed.data.id;
  const b = parsed.data;

  let agent;
  switch (b.action) {
    case 'add':
      agent = await addPersonaNote(user.id, id, { kind: b.kind, content: b.content });
      break;
    case 'edit':
      agent = await editPersonaNote(user.id, id, { ref: b.ref, kind: b.kind, content: b.content });
      break;
    case 'retire':
      agent = await retirePersonaNote(user.id, id, b.ref);
      break;
    case 'restore':
      agent = await restorePersonaNote(user.id, id, b.ref);
      break;
  }

  if (!agent) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ agent });
}
