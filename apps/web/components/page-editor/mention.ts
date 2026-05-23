import Mention from '@tiptap/extension-mention';
import { ReactRenderer } from '@tiptap/react';
import {
  MentionList,
  type MentionItem,
  type MentionListHandle,
  type MentionListProps,
} from './mention-list';

/**
 * @-mention that resolves the owner's EXISTING entities (read-only lookup via
 * /api/entities/search). The chip carries the entity's name + id; the name
 * lands in `doc_text`, so the existing extractor reconciles it into the graph
 * (`mentioned_in` edges) on commit — no backend pipeline changes here.
 *
 * Names with no matching entity simply aren't mentionable; type them as plain
 * text and the extractor creates the entity as it does for any content.
 */
export const PageMention = Mention.configure({
  HTMLAttributes: { class: 'mention' },
  suggestion: {
    char: '@',

    items: async ({ query }): Promise<MentionItem[]> => {
      try {
        const res = await fetch(`/api/entities/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) return [];
        const data = (await res.json()) as { entities?: MentionItem[] };
        return data.entities ?? [];
      } catch {
        return [];
      }
    },

    // Insert the mention node + a trailing space (the documented pattern).
    command: ({ editor, range, props }) => {
      const after = editor.view.state.selection.$to.nodeAfter;
      if (after?.text?.startsWith(' ')) range.to += 1;
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          { type: 'mention', attrs: { id: props.id, label: props.label } },
          { type: 'text', text: ' ' },
        ])
        .run();
    },

    render: () => {
      let component: ReactRenderer<MentionListHandle, MentionListProps> | null = null;
      let popup: HTMLDivElement | null = null;

      const reposition = (rectFn?: (() => DOMRect | null) | null) => {
        if (!popup || !rectFn) return;
        const rect = rectFn();
        if (!rect) return;
        const margin = 6;
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
          component = new ReactRenderer(MentionList, { props, editor: props.editor });
          popup = document.createElement('div');
          popup.style.position = 'fixed';
          popup.style.zIndex = '50';
          popup.appendChild(component.element);
          document.body.appendChild(popup);
          reposition(props.clientRect);
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
  },
});
