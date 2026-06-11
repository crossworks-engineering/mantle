'use client';

/**
 * "Update available" chip at the top of the sidebar menus. Renders NOTHING
 * unless the (server-cached) release check says a newer version exists —
 * up-to-date installs, dev, and offline boxes never see it. Clicking goes to
 * /settings/updates where the actual update runs.
 *
 * In the collapsed icon rail the label hides and the icon stands alone,
 * following the sidebar's group-data-[nav-collapsed]/shell pattern.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowUpCircle } from 'lucide-react';

type CheckPayload = {
  updateAvailable?: boolean;
  latest?: { tag?: string } | null;
};

const RECHECK_MS = 6 * 60 * 60 * 1000; // matches the server cache TTL

export function UpdateBanner({ onNavigate }: { onNavigate?: () => void }) {
  const [tag, setTag] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/api/updates/check', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as CheckPayload;
        if (!cancelled) setTag(data.updateAvailable ? (data.latest?.tag ?? null) : null);
      } catch {
        // Offline / transient — just don't show the banner.
      }
    };
    void check();
    const t = setInterval(check, RECHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!tag) return null;

  return (
    <div className="px-3 pt-3 group-data-[nav-collapsed=true]/shell:px-2">
      <Link
        href="/settings/updates"
        onClick={onNavigate}
        className="flex items-center gap-2 rounded-md bg-accent px-3 py-2 text-xs font-medium text-accent-foreground transition-colors hover:bg-accent/80 group-data-[nav-collapsed=true]/shell:justify-center group-data-[nav-collapsed=true]/shell:px-0 group-data-[nav-collapsed=true]/shell:py-2"
        title={`Update available — ${tag}`}
      >
        <ArrowUpCircle className="size-4 shrink-0" />
        <span className="truncate group-data-[nav-collapsed=true]/shell:hidden">
          Update available · {tag}
        </span>
      </Link>
    </div>
  );
}
