import Mention from '@tiptap/extension-mention';
import { ReactRenderer } from '@tiptap/react';
import {
  MentionList,
  type MentionItem,
  type MentionListHandle,
  type MentionListProps,
} from './mention-list';

/**
 * @-mention / link. One picker resolves the owner's existing references
 * (read-only via /api/mentions/search):
 *   - a page/note → chip with `ref:'node'` → the extractor makes a
 *     `node --references--> node` edge (backlinks)
 *   - a person/project/place → chip with `ref:'entity'` → `mentioned_in` edge
 *
 * Chips carry { id, label, ref, kind }; the name lands in `doc_text` for the
 * brain. Targets that don't match an existing page/note/entity aren't
 * mentionable — type them as plain text.
 */
export const PageMention = Mention.extend({
  addAttributes() {
    return {
      ...(this.parent?.() ?? {}),
      ref: {
        default: 'entity',
        parseHTML: (el) => el.getAttribute('data-ref') ?? 'entity',
        renderHTML: (attrs) => (attrs.ref ? { 'data-ref': attrs.ref } : {}),
      },
      kind: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-kind'),
        renderHTML: (attrs) => (attrs.kind ? { 'data-kind': attrs.kind } : {}),
      },
    };
  },
}).configure({
  HTMLAttributes: { class: 'mention' },
  suggestion: {
    char: '@',

    items: async ({ query }): Promise<MentionItem[]> => {
      try {
        const res = await fetch(`/api/mentions/search?q=${encodeURIComponent(query)}`);
        if (!res.ok) return [];
        const data = (await res.json()) as { items?: MentionItem[] };
        return data.items ?? [];
      } catch {
        return [];
      }
    },

    command: ({ editor, range, props }) => {
      const item = props as unknown as MentionItem;
      const after = editor.view.state.selection.$to.nodeAfter;
      if (after?.text?.startsWith(' ')) range.to += 1;
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: 'mention',
            attrs: { id: item.id, label: item.label, ref: item.ref, kind: item.kind },
          },
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
