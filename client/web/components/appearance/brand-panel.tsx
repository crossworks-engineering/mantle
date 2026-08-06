'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { useFonts } from '@mantle/web-ui/font-provider';
import { FontPicker } from '@/components/appearance/font-picker';
import { LogoControl } from '@/components/appearance/logo-control';

/**
 * Brand — everything the header's identity is made of, one column each: the
 * logo upload first, then the wordmark and peer-name font libraries as TALL
 * columns that run their full height — no inner scroller, so the page is the
 * only thing that scrolls and the whole face library just reads down it. Fonts apply only when no logo image is set (the image replaces
 * the wordmark text); the pickers stay useful as the fallback brand and the
 * peer-name face.
 *
 * This was the "Logo" tab of the old theme-preview strip. When that strip went
 * (it was demo surfaces — a fake dashboard, a fake mailbox — on a screen that
 * is meant to be settings), these were the only real settings inside it, so
 * they moved up onto the page rather than going with it.
 */
export function BrandPanel() {
  const { logoFont, titleFont, setLogoFont, setTitleFont } = useFonts();
  const shell = useQuery({
    queryKey: ['shell'],
    queryFn: () => apiFetch<{ siteName: string | null; peerName: string | null }>('/api/shell'),
  });
  const wordmark = shell.data?.siteName || 'mantle';
  const peer = shell.data?.peerName || 'Peer name';

  return (
    <div className="grid items-start gap-6 md:grid-cols-3">
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Logo
        </h2>
        <LogoControl />
      </section>
      <FontPicker
        title="Wordmark"
        sample={wordmark}
        value={logoFont}
        onChange={setLogoFont}
        unbounded
      />
      <FontPicker
        title="Peer name"
        sample={peer}
        value={titleFont}
        onChange={setTitleFont}
        unbounded
      />
    </div>
  );
}
