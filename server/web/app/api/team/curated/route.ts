/**
 * GET /api/team/curated — the member Dashboard's curated tag sections: one
 * section per owner-picked tag (prefs.teamHubTags, pref order = display
 * order), each holding up to 5 team-visible PAGE shares carrying the tag,
 * newest-updated first. Empty `sections` when the owner curates nothing —
 * the Dashboard simply renders no block.
 *
 * The pref only groups; visibility stays the share's job — every item here is
 * an active team/public share a member could already open from /team/pages,
 * and opening one still goes through /s/<token> (the only content door).
 *
 * Same trust model as the rest of /api/team: self-authenticated via
 * resolveTeamChatCaller, membership liveness re-checked on every call.
 */
import { NextResponse } from 'next/server';
import { curatedTeamSections, loadProfilePreferences } from '@mantle/content';
import { resolveTeamChatCaller } from '@/lib/team-chat-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const prefs = await loadProfilePreferences(caller.ownerId);
  const tags = prefs.teamHubTags ?? [];
  const sections = tags.length > 0 ? await curatedTeamSections(caller.ownerId, tags) : [];
  return NextResponse.json({ sections });
}
