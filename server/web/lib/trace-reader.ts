import { adminFacts } from '@/lib/auth/login';
import { ownerUserLogin, type SessionUser } from '@/lib/auth/session';
import { toolMakerFor } from '@/lib/tools';
import { OWNER_TRACE_READER, type TraceReader } from '@/lib/traces';

/**
 * Who the signed-in login reads traces as (the Activity column, the
 * journey feed, /traces). The brain owner (the anchor login) reads its
 * own turns and the system's work. Any other login reads its own turns,
 * and the system's work too when it is an Admin user with the settings
 * area, as its scope answers it (adminFacts of the owner the handler
 * read, ownerUserLogin; a user no owner answer gave holds none). No
 * reader reads another login's turns.
 */
export async function traceReaderFor(user: SessionUser): Promise<TraceReader> {
  const login = toolMakerFor(user);
  if (!login) return OWNER_TRACE_READER;
  const asked = ownerUserLogin(user);
  const system = !!asked && (await adminFacts(asked)).areas.has('settings');
  return { login, system };
}
