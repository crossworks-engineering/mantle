import { Extension } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { ReactRenderer } from '@tiptap/react';
import {
  getSlashItems,
  SlashMenu,
  type SlashItem,
  type SlashMenuHandle,
  type SlashMenuProps,
} from './slash-menu';

/**
 * Slash command: type "/" to open a spacious block picker. Built on TipTap's
 * Suggestion utility (the same primitive behind @-mentions). The popup is a
 * React component (SlashMenu) mounted to <body> and positioned at the caret
 * with plain fixed-positioning + a flip-up when there's no room below — no
 * tippy / floating-ui dependency.
 *
 * No schema/nodes are added here, so this stays editor-only and the read-only
 * PageView (which omits it) renders identically.
 */
export const SlashCommand = Extension.create({
  name: 'slashCommand',

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashItem>({
        editor: this.editor,
        char: '/',
        startOfLine: false,
        // Run the chosen item's command against the slash range.
        command: ({ editor, range, props }) => {
          props.command({ editor, range });
        },
        items: ({ query }) => getSlashItems(query),
        render: () => {
          let component: ReactRenderer<SlashMenuHandle, SlashMenuProps> | null = null;
          let popup: HTMLDivElement | null = null;
          let rectFn: (() => DOMRect | null) | null | undefined = null;
          let ro: ResizeObserver | null = null;

          const reposition = () => {
            if (!popup || !rectFn) return;
            const rect = rectFn();
            if (!rect) return;
            const margin = 8;
            const w = popup.offsetWidth;
            const h = popup.offsetHeight;
            const flipUp =
              rect.bottom + margin + h > window.innerHeight && rect.top - margin - h > 0;
            let top = flipUp ? rect.top - margin - h : rect.bottom + margin;
            let left = rect.left;
            // Clamp fully on-screen. A menu overflowing the viewport is what let
            // the arrow-key scrollIntoView (in SlashMenu) yank the whole page on
            // first open — keeping it on-screen makes that scroll a no-op.
            left = Math.max(margin, Math.min(left, window.innerWidth - w - margin));
            top = Math.max(margin, Math.min(top, window.innerHeight - h - margin));
            popup.style.left = `${Math.round(left)}px`;
            popup.style.top = `${Math.round(top)}px`;
          };

          const close = () => {
            ro?.disconnect();
            ro = null;
            popup?.remove();
            popup = null;
            component?.destroy();
            component = null;
          };

          return {
            onStart: (props) => {
              rectFn = props.clientRect;
              component = new ReactRenderer(SlashMenu, { props, editor: props.editor });
              popup = document.createElement('div');
              popup.style.position = 'fixed';
              popup.style.zIndex = '50';
              popup.appendChild(component.element);
              document.body.appendChild(popup);
              reposition();
              // ReactRenderer commits the menu content asynchronously, so its
              // height isn't known yet. Reposition the moment it gets a real size
              // (and whenever the filtered list changes height) — this is what
              // fixes the "first open jumps off-screen on arrow-key" bug.
              ro = new ResizeObserver(() => reposition());
              ro.observe(popup);
            },
            onUpdate: (props) => {
              rectFn = props.clientRect;
              component?.updateProps(props);
              reposition();
            },
            onKeyDown: (props) => {
              if (props.event.key === 'Escape') {
                close();
                return true;
              }
              return component?.ref?.onKeyDown(props) ?? false;
            },
            onExit: () => close(),
          };
        },
      }),
    ];
  },
});
