'use client';

import { Maximize2, Minimize2 } from 'lucide-react';
import { Button } from '@mantle/web-ui/ui/button';
import { useZenMode } from '@/components/layout/zen-mode';

/**
 * The focus-mode control: the shell hides its four chrome regions and the
 * content takes the whole viewport.
 *
 * ONE button does both directions, and it is the only control — the shell's
 * chrome is gone, so a separate exit affordance would have nowhere to live.
 * Whichever toolbar renders this must therefore survive focus mode itself
 * (the editors' toolbars and the list previews' header rows both do).
 *
 * Shared rather than inlined per screen because the four surfaces that offer
 * it — the Pages and Draw editors, and the Pages and Draw previews — must
 * agree on the label and the pressed state, or the same control reads as two
 * different features.
 */
export function FocusToggle() {
  const { zen, toggle } = useZenMode();
  return (
    <Button
      size="sm"
      variant={zen ? 'default' : 'ghost'}
      onClick={toggle}
      aria-pressed={zen}
      aria-label={zen ? 'Exit focus mode' : 'Focus mode'}
      title={zen ? 'Exit focus mode' : 'Focus mode — hide the app chrome'}
    >
      {zen ? <Minimize2 /> : <Maximize2 />}
    </Button>
  );
}
