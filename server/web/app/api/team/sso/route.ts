/**
 * POST /api/team/sso — top-level bearer→cookie handoff for share reading.
 * All logic (and the contract tests) live in lib/team-sso.ts.
 */
import { handleTeamSso } from '@/lib/team-sso';


export async function POST(req: Request) {
  return handleTeamSso(req);
}
