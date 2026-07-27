'use client';

import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert, type LucideIcon } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import { CALLOUT_VARIANTS, type CalloutVariant } from './callout';

// Literal class strings (no dynamic construction) so Tailwind v4 picks them up.
const VARIANT_STYLES: Record<CalloutVariant, { icon: LucideIcon; wrap: string; tint: string }> = {
  info: { icon: Info, wrap: 'border-info/30 bg-info/10', tint: 'text-info-ink' },
  success: { icon: CheckCircle2, wrap: 'border-success/30 bg-success/10', tint: 'text-success-ink' },
  warning: { icon: AlertTriangle, wrap: 'border-warning/30 bg-warning/10', tint: 'text-warning-ink' },
  danger: {
    icon: OctagonAlert,
    wrap: 'border-destructive/30 bg-destructive/10',
    tint: 'text-destructive-ink',
  },
};

export function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const variant: CalloutVariant = CALLOUT_VARIANTS.includes(node.attrs.variant)
    ? node.attrs.variant
    : 'info';
  const style = VARIANT_STYLES[variant];
  const Icon = style.icon;

  // Click the icon to cycle info → success → warning → danger.
  const cycle = () => {
    const next =
      CALLOUT_VARIANTS[(CALLOUT_VARIANTS.indexOf(variant) + 1) % CALLOUT_VARIANTS.length];
    updateAttributes({ variant: next });
  };

  return (
    <NodeViewWrapper className={cn('my-3 flex gap-3 rounded-lg border px-3 py-2', style.wrap)}>
      {editor.isEditable ? (
        <button
          type="button"
          contentEditable={false}
          onClick={cycle}
          aria-label={`Callout style: ${variant} (click to change)`}
          className="mt-0.5 shrink-0 rounded transition-transform hover:scale-110"
        >
          <Icon className={cn('size-5', style.tint)} aria-hidden />
        </button>
      ) : (
        <span contentEditable={false} className="mt-0.5 shrink-0">
          <Icon className={cn('size-5', style.tint)} aria-hidden />
        </span>
      )}
      <NodeViewContent className="min-w-0 flex-1 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
    </NodeViewWrapper>
  );
}
