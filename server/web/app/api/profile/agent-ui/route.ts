import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import type { AgentUiSetting } from '@mantle/client-types/agent-ui';
import { anyLoginCaller } from '@/lib/auth';
import { loadPreferencesFor, savePreferencesFor } from '@mantle/content';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any' },
  PUT: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: "the login's own things, not an item" },
  },
});

/**
 * The login's agent UI setting (docs/agent-ui.md): whether an in-app agent
 * may drive this login's window. On its own profile row, off until the login
 * turns it on. The brain reads it when a turn starts: the ui_* tools are
 * offered only to a turn that named its window while it is on.
 *
 *   GET -> 200 { enabled }
 *   PUT { enabled, loginId }
 *       -> 200 { enabled }   the stored value
 *       -> 403 { error, code: 'login-mismatch' }   when `loginId` is not the
 *                                                  login of this session
 *       -> 400              anything else
 *
 * As /api/profile/sounds: the body names the login the choice was made as,
 * so a tab left on one login never writes another's; open to every login
 * (`open: 'any'`), each its own row only (mantle_profile_writable, 0302).
 */
export async function GET() {
  const login = anyLoginCaller();
  const prefs = await loadPreferencesFor(login.loginId);
  const body: AgentUiSetting = { enabled: prefs.agentUi === true };
  return NextResponse.json(body);
}

const Body = z.object({
  enabled: z.boolean(),
  // Optional here so a body naming no login is the 403 below, as one
  // naming another is.
  loginId: z.unknown().optional(),
});

export async function PUT(req: Request) {
  const login = anyLoginCaller();
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'enabled (boolean) required' }, { status: 400 });
  }
  if (parsed.data.loginId !== login.loginId) {
    return NextResponse.json(
      { error: 'loginId is not the login of this session', code: 'login-mismatch' },
      { status: 403 },
    );
  }
  const preferences = await savePreferencesFor(login.loginId, { agentUi: parsed.data.enabled });
  const body: AgentUiSetting = { enabled: preferences.agentUi === true };
  return NextResponse.json(body);
}
