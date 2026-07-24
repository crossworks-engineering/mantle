'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@mantle/web-ui/api-fetch';
import { useFonts } from '@/components/font-provider';
import { FontPicker } from '@/components/appearance/font-picker';

/**
 * The wordmark + page-title font selectors, grouped for the Typography preview
 * (they sit above the Font Showcase there). Self-contained — reads the live
 * choices from the FontProvider and the site name from the cached ['shell']
 * query so the wordmark preview shows the real name.
 */
export function TypographyFontControls() {
  const { logoFont, titleFont, setLogoFont, setTitleFont } = useFonts();
  const shell = useQuery({
    queryKey: ['shell'],
    queryFn: () => apiFetch<{ siteName: string | null; peerName: string | null }>('/api/shell'),
  });
  const wordmark = shell.data?.siteName || 'mantle';
  const peer = shell.data?.peerName || 'Peer name';

  return (
    <div className="space-y-3">
      <FontPicker title="Wordmark" sample={wordmark} value={logoFont} onChange={setLogoFont} />
      <FontPicker title="Peer name" sample={peer} value={titleFont} onChange={setTitleFont} />
    </div>
  );
}
