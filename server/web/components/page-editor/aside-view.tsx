'use client';

import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Sparkles } from 'lucide-react';
import { cn } from '@mantle/web-ui/lib/utils';
import {
  asideBackground,
  asideBorderColor,
  normalizeAsideAngle,
  normalizeAsideColor,
  randomAsideAngle,
  ASIDE_COLORS,
} from './aside-style';

/**
 * Aside NodeView — a rounded, soft-shadowed panel with a themed gradient fill.
 * Distinct from `callout` (flat tint + leading icon): no icon, no left bar — a
 * full gradient wash + faint themed border. In edit mode a small ✨ swatch in the
 * top-right cycles the selected theme colour AND reshuffles the gradient angle,
 * so "a random gradient based on the selected colour" is one click away.
 */
export function AsideView({ node, updateAttributes, editor }: NodeViewProps) {
  const color = normalizeAsideColor(node.attrs.color);
  const angle = normalizeAsideAngle(node.attrs.angle);

  // Cycle to the next theme colour and generate a fresh random angle.
  const shuffle = () => {
    const next = ASIDE_COLORS[(ASIDE_COLORS.indexOf(color) + 1) % ASIDE_COLORS.length]!;
    updateAttributes({ color: next, angle: randomAsideAngle() });
  };

  return (
    <NodeViewWrapper
      data-aside=""
      data-color={color}
      className="group/aside relative my-3 rounded-xl border px-5 py-4 shadow-sm"
      style={{ background: asideBackground(color, angle), borderColor: asideBorderColor(color) }}
    >
      {editor.isEditable && (
        <button
          type="button"
          contentEditable={false}
          onClick={shuffle}
          aria-label={`Aside colour: ${color} (click to shuffle the gradient)`}
          className={cn(
            'absolute right-2 top-2 grid size-6 place-items-center rounded-full',
            'bg-background/60 text-foreground/70 opacity-0 backdrop-blur transition',
            'hover:scale-110 hover:text-foreground focus-visible:opacity-100',
            'group-hover/aside:opacity-100',
          )}
        >
          <Sparkles className="size-3.5" aria-hidden />
        </button>
      )}
      <NodeViewContent className="min-w-0 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0" />
    </NodeViewWrapper>
  );
}
