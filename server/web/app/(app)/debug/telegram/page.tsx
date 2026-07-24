import { requireOwner } from '@/lib/auth';
import { SetPageTitle } from '@/components/layout/page-title';
import { DebugTabs } from '../debug-tabs';
import { TelegramClient } from './telegram-client';

/** Debug → Telegram chats. Data-free: TelegramClient fetches GET /api/debug/telegram. */
export default async function DebugTelegramPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string }>;
}) {
  await requireOwner();
  const sp = await searchParams;
  const page = Math.max(1, Number.parseInt(sp.page ?? '1', 10) || 1);
  const query = sp.q?.trim() || '';

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-6 py-8">
      <DebugTabs />
      <SetPageTitle title="Telegram" />
      <TelegramClient page={page} query={query} />
    </div>
  );
}
