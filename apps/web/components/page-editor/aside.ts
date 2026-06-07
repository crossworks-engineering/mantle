import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { AsideView } from './aside-view';
import {
  asideBackground,
  asideBorderColor,
  DEFAULT_ASIDE_ANGLE,
  DEFAULT_ASIDE_COLOR,
  normalizeAsideAngle,
  normalizeAsideColor,
} from './aside-style';

/**
 * Aside: a fancier cousin of `callout` — a boxed block wrapping block content,
 * painted with a themed gradient (a selected `chart-N` colour + a gradient
 * `angle`) instead of callout's flat tint + icon. Both live in the shared
 * schema so the read-only PageView renders them identically. The colour/angle
 * live in node attrs (carried in the ProseMirror JSON); the React NodeView
 * paints the chrome, and the gradient style is mirrored onto the rendered HTML
 * so the public/raw renderer (which has no NodeView) shades it the same way.
 */
export const Aside = Node.create({
  name: 'aside',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      color: {
        default: DEFAULT_ASIDE_COLOR,
        parseHTML: (el) => normalizeAsideColor(el.getAttribute('data-color')),
        renderHTML: (attrs) => ({ 'data-color': normalizeAsideColor(attrs.color) }),
      },
      angle: {
        default: DEFAULT_ASIDE_ANGLE,
        parseHTML: (el) => normalizeAsideAngle(el.getAttribute('data-angle')),
        renderHTML: (attrs) => ({ 'data-angle': String(normalizeAsideAngle(attrs.angle)) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-aside]' }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const color = normalizeAsideColor(node.attrs.color);
    const angle = normalizeAsideAngle(node.attrs.angle);
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-aside': '',
        style: `background:${asideBackground(color, angle)};border-color:${asideBorderColor(color)}`,
      }),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(AsideView);
  },
});
