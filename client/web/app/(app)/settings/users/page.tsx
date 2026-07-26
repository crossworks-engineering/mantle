import { SetPageTitle } from '@/components/layout/page-title';
import { UsersClient } from './users-client';

/**
 * Logins: ways INTO the one brain — not tenants, not separate users with
 * separate data. Every login sees the same brain; only the audit trail
 * distinguishes them. Data-free page —
 * UsersClient fetches from GET /api/users and mutates via POST/PATCH/DELETE
 * /api/users[/id] (+ /password for resets).
 */
export default async function UsersSettingsPage() {
  return (
    <>
      <SetPageTitle title="Logins" />
      <UsersClient />
    </>
  );
}
