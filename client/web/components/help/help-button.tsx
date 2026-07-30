'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { CircleQuestionMark } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { helpTopicForPath } from '@mantle/web-ui/layout/help-topics';

/**
 * The "?" beside Search in the header. This file is the ONLY part of the help
 * system in the default bundle, and it is deliberately tiny: an icon, a
 * pathname lookup and a boolean.
 *
 * Everything expensive — the panel, `react-markdown`, `remark-gfm` and the
 * content itself — sits behind the dynamic import below, which Next only
 * resolves once `open` first flips true. A screen therefore costs nothing extra
 * until the reader actually asks for help, which is the constraint the whole
 * feature was designed around.
 */
const HelpPanel = dynamic(() => import('./help-panel').then((m) => m.HelpPanel), {
  ssr: false,
});

export function HelpButton() {
  const pathname = usePathname();
  const topic = helpTopicForPath(pathname ?? '/');
  // Mount the panel only after the first click; unmounting on close would throw
  // away the fetched content, so once opened it stays mounted (and cached).
  const [everOpened, setEverOpened] = useState(false);
  const [open, setOpen] = useState(false);

  // No topic for this screen yet ⇒ no affordance at all. Coverage can grow
  // route by route without a half-built "?" that opens an empty panel.
  if (!topic) return null;

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        aria-label="About this screen"
        onClick={() => {
          setEverOpened(true);
          setOpen(true);
        }}
      >
        <CircleQuestionMark className="size-5" />
      </Button>
      {everOpened && <HelpPanel topic={topic} open={open} onOpenChange={setOpen} />}
    </>
  );
}
