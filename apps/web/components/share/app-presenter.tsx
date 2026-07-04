'use client';

/**
 * Public presenter for a SHARED mini-app. The app gets the WHOLE viewport
 * (h-dvh, no chrome) in share mode (shareToken) so the bundle + tool/db
 * brokers resolve under /s/<token>/* — no owner session. How the app fills
 * (or doesn't fill) that space is the app's own business; it owns its
 * internal layout and scrolling.
 */
import { AppSandbox } from '@/components/app-sandbox/app-sandbox';
import type { ShareView } from '@/lib/shares';

export function AppPresenter({
  view,
  token,
}: {
  view: Extract<ShareView, { kind: 'app' }>;
  token: string;
}) {
  return (
    <div className="h-dvh w-full">
      <AppSandbox appId={view.appId} shareToken={token} frame="viewport" />
    </div>
  );
}
