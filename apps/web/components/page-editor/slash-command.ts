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

          const reposition = (rectFn?: (() => DOMRect | null) | null) => {
            if (!popup || !rectFn) return;
            const rect = rectFn();
            if (!rect) return;
            const margin = 8;
            const height = popup.offsetHeight;
            const flipUp =
              rect.bottom + margin + height > window.innerHeight && rect.top - margin - height > 0;
            popup.style.left = `${Math.round(rect.left)}px`;
            popup.style.top = `${Math.round(flipUp ? rect.top - margin - height : rect.bottom + margin)}px`;
          };

          const close = () => {
            popup?.remove();
            popup = null;
            component?.destroy();
            component = null;
          };

          return {
            onStart: (props) => {
              component = new ReactRenderer(SlashMenu, { props, editor: props.editor });
              popup = document.createElement('div');
              popup.style.position = 'fixed';
              popup.style.zIndex = '50';
              popup.appendChild(component.element);
              document.body.appendChild(popup);
              reposition(props.clientRect);
              // Re-measure after paint so the flip-up calc has a real height.
              requestAnimationFrame(() => reposition(props.clientRect));
            },
            onUpdate: (props) => {
              component?.updateProps(props);
              reposition(props.clientRect);
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
