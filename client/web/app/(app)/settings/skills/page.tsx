import { SetPageTitle } from '@/components/layout/page-title';
import { SkillsClient } from './skills-client';

/**
 * Skills settings — the first screen converted to client data-fetching
 * (Phase 2 · Task 4). The page is now data-free: it only enforces the auth gate
 * server-side; the list + heartbeat backrefs are fetched in the client with
 * TanStack Query (`/api/skills`, `/api/skills/backrefs`). No server-side DB read,
 * so it also renders under DB-less dev.
 */
export default async function SkillsPage() {
  return (
    <>
      <SetPageTitle title="Skills" />
      <SkillsClient />
    </>
  );
}
