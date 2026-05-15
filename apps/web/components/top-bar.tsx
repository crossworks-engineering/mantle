import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { SignOutButton } from '@/app/forbidden/sign-out';

export function TopBar({ email }: { email: string | null }) {
  return (
    <header className="col-start-2 flex h-12 items-center gap-3 border-b border-border px-4">
      <div className="relative max-w-xl flex-1">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          placeholder="Search across everything…"
          className="h-8 pl-8 text-sm"
        />
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {email && <span>{email}</span>}
        <SignOutButton />
      </div>
    </header>
  );
}
