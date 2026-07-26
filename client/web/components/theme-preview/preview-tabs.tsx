'use client';

import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@mantle/web-ui/ui/tabs';
import { ColorPalette } from '@/components/theme-preview/color-palette';

const Loading = () => (
  <div className="flex h-full items-center justify-center py-24 text-muted-foreground">
    <Loader2 className="size-6 animate-spin" aria-hidden />
  </div>
);

// Heavy demo surfaces — loaded on demand, client-only (charts/sidebar
// don't need SSR for a preview).
const CardsDemo = dynamic(() => import('@/components/examples/cards'), {
  loading: Loading,
  ssr: false,
});
const Dashboard = dynamic(() => import('@/components/examples/dashboard'), {
  loading: Loading,
  ssr: false,
});
const MailDemo = dynamic(() => import('@/components/examples/mail'), {
  loading: Loading,
  ssr: false,
});
const MemoryTiers = dynamic(() => import('@/components/examples/pricing/pricing'), {
  loading: Loading,
  ssr: false,
});
const LogoTab = dynamic(() => import('@/components/appearance/logo-tab'), {
  loading: Loading,
});
const Typography = dynamic(() => import('@/components/examples/typography/typography-demo'), {
  loading: Loading,
  ssr: false,
});

const TABS = [
  // 'cards' keeps its value (the default-tab anchor); the LABEL is Theme —
  // it's the audition surface for the active theme, not a cards gallery.
  { value: 'cards', label: 'Theme' },
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'mail', label: 'Mail' },
  { value: 'memory', label: 'Memory tiers' },
  { value: 'colors', label: 'Color Palette' },
  { value: 'logo', label: 'Logo' },
  { value: 'typography', label: 'Typography' },
];

/** Theme preview surfaces (adapted from tweakcn) so we can audition the
 *  active theme on real components. */
export function PreviewTabs() {
  return (
    <Tabs defaultValue="cards" className="@container w-full">
      <TabsList className="mb-3 flex w-full flex-wrap justify-end gap-1 bg-transparent p-0">
        {TABS.map((t) => (
          <TabsTrigger
            key={t.value}
            value={t.value}
            className="rounded-full data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
          >
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="cards" className="m-0">
        <CardsDemo />
      </TabsContent>
      <TabsContent value="dashboard" className="m-0">
        <Dashboard />
      </TabsContent>
      <TabsContent value="mail" className="m-0">
        <MailDemo />
      </TabsContent>
      <TabsContent value="memory" className="m-0">
        <MemoryTiers />
      </TabsContent>
      <TabsContent value="colors" className="m-0">
        <ColorPalette />
      </TabsContent>
      <TabsContent value="logo" className="m-0">
        <LogoTab />
      </TabsContent>
      <TabsContent value="typography" className="m-0">
        <Typography />
      </TabsContent>
    </Tabs>
  );
}
