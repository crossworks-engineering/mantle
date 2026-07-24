import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { UsersClient } from './users-client';

/**
 * Users: co-admin logins into the one brain (not tenants). Data-free page —
 * UsersClient fetches from GET /api/users and mutates via POST/PATCH/DELETE
 * /api/users[/id] (+ /password for resets).
 */
export default async function UsersSettingsPage() {
  await requireOwner();
  return (
    <>
      <SetPageTitle title="Users" />
      <UsersClient />
    </>
  );
}
