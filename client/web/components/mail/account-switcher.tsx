'use client';

import { useRouter } from 'next/navigation';
import { Mail } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@mantle/web-ui/ui/select';

export type MailAccount = { id: string; address: string; provider: string };

/**
 * Account picker for the mail screen. Adapted from the appearance demo's
 * AccountSwitcher: instead of local Zustand state it navigates to
 * `/inbox?account=<id>`, so the server page re-runs its scoped queries.
 */
export function AccountSwitcher({
  isCollapsed,
  accounts,
  currentAccountId,
}: {
  isCollapsed: boolean;
  accounts: MailAccount[];
  currentAccountId: string;
}) {
  const router = useRouter();
  const current = accounts.find((a) => a.id === currentAccountId) ?? accounts[0];

  return (
    <Select value={currentAccountId} onValueChange={(id) => router.push(`/inbox?account=${id}`)}>
      <SelectTrigger
        className={cn(
          'flex w-full items-center gap-2 [&>span]:line-clamp-1 [&>span]:flex [&>span]:w-full [&>span]:items-center [&>span]:gap-1 [&>span]:truncate [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0',
          isCollapsed &&
            'flex h-9 w-9 shrink-0 items-center justify-center p-0 [&>span]:w-auto [&>svg]:hidden',
        )}
        aria-label="Select account"
      >
        <SelectValue placeholder="Select an account">
          <Mail />
          <span className={cn('ml-2', isCollapsed && 'hidden')}>{current?.address}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {accounts.map((account) => (
          <SelectItem key={account.id} value={account.id}>
            <div className="flex items-center gap-2 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 [&_svg]:text-foreground">
              <Mail />
              {account.address}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
