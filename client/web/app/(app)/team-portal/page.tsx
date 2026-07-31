import { SetPageTitle } from '@/components/layout/page-title';
import { TeamPortalClient } from './team-portal-client';

/**
 * /team-portal — the owner-space front door to the member-facing portal.
 *
 * The portal itself lives at /team, OUTSIDE the (app) shell and behind a team
 * member's token, so an owner has no way to discover it, no way to see who can
 * reach it, and no way to try it without minting themselves a token. This page
 * is that missing signpost: the current roster, how the token model works, a
 * route to Contacts where tokens are actually minted, and a new-tab button to
 * open the portal and see what a member sees.
 *
 * Data-free (the /pages convention): TeamPortalClient fetches the roster from
 * GET /api/team-portal.
 */
export default async function TeamPortalPage() {
  return (
    <>
      <SetPageTitle title="Team Portal" />
      <TeamPortalClient />
    </>
  );
}
