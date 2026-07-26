'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { useFonts } from '@mantle/web-ui/font-provider';
import { FontPicker } from '@/components/appearance/font-picker';
import { LogoControl } from '@/components/appearance/logo-control';

/**
 * The Logo tab (Appearance → preview strip, between Color Palette and
 * Typography): everything the header's identity is made of, one column each —
 * the logo upload first, then the wordmark and peer-name font libraries as
 * TALL columns so the whole face library reads at a glance instead of through
 * a letterbox. Fonts still apply only when no logo image is set (the image
 * replaces the wordmark text); the pickers stay useful as the fallback brand
 * and the peer-name face.
 */
export default function LogoTab() {
  const { logoFont, titleFont, setLogoFont, setTitleFont } = useFonts();
  const shell = useQuery({
    queryKey: ['shell'],
    queryFn: () => apiFetch<{ siteName: string | null; peerName: string | null }>('/api/shell'),
  });
  const wordmark = shell.data?.siteName || 'mantle';
  const peer = shell.data?.peerName || 'Peer name';

  return (
    <div className="grid items-start gap-6 p-1 md:grid-cols-3">
      <section className="space-y-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Logo
        </h2>
        <LogoControl />
      </section>
      <FontPicker title="Wordmark" sample={wordmark} value={logoFont} onChange={setLogoFont} tall />
      <FontPicker title="Peer name" sample={peer} value={titleFont} onChange={setTitleFont} tall />
    </div>
  );
}
