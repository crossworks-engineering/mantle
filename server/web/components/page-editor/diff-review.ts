import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { DiffOverlay, RemovedGhost } from '@mantle/content/page-diff';

/**
 * DiffReview — an editor-only overlay that paints the page's "review mode"
 * (Phase 3a Pass 2): exactly what Commit will publish vs the live page.
 *
 *   - added blocks   → green border (`is-diff-added`)
 *   - changed blocks → amber border (`is-diff-changed`)
 *   - removed blocks → a red, struck-through GHOST card rendered as a widget at
 *     the spot it used to occupy (removed content isn't in the draft, so a
 *     widget is the only way to show a deletion at all)
 *
 * Each added/changed block gets a small "Discard" pill; each ghost a "Restore"
 * button. They don't mutate the doc themselves — they dispatch a bubbling
 * `mantle:diff-action` CustomEvent ({ action:'discard'|'restore', id }) on the
 * editor DOM; the host React component does the surgery (revert/delete/reinsert)
 * and pushes a fresh overlay. NEVER mutates the document directly; driven by a
 * meta transaction (`setMeta(diffReviewKey, overlay | null)`), so it can't trip
 * autosave (PageEditor.onUpdate guards on docChanged).
 */

export const diffReviewKey = new PluginKey<DiffReviewState>('diffReview');

export const DIFF_ACTION_EVENT = 'mantle:diff-action';

interface DiffReviewState {
  overlay: DiffOverlay | null;
  deco: DecorationSet;
}

function actionButton(
  label: string,
  title: string,
  action: string,
  id: string,
  cls: string,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = cls;
  btn.textContent = label;
  btn.title = title;
  btn.setAttribute('contenteditable', 'false');
  // mousedown (not click) + preventDefault so pressing it never moves the editor
  // selection/focus before the action runs.
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.dispatchEvent(
      new CustomEvent(DIFF_ACTION_EVENT, { bubbles: true, detail: { action, id } }),
    );
  });
  return btn;
}

function ghostWidget(g: RemovedGhost): HTMLElement {
  const card = document.createElement('div');
  card.className = 'diff-removed-ghost';
  card.setAttribute('contenteditable', 'false');

  const head = document.createElement('div');
  head.className = 'diff-removed-head';
  const tag = document.createElement('span');
  tag.className = 'diff-removed-tag';
  tag.textContent = `− Removed ${g.kind}`;
  head.appendChild(tag);
  head.appendChild(
    actionButton('Restore', 'Restore this block', 'restore', g.id, 'diff-pill diff-pill-restore'),
  );
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'diff-removed-body';
  body.textContent = g.text || '(empty block)';
  card.appendChild(body);

  return card;
}

function decorate(doc: PMNode, overlay: DiffOverlay): DecorationSet {
  const added = new Set(overlay.addedIds);
  const changed = new Set(overlay.changedIds);
  const decos: Decoration[] = [];

  // Map top-level block id → end position, so a ghost can anchor after it.
  const topEnd = new Map<string, number>();
  doc.forEach((node, offset) => {
    const id = node.attrs?.id;
    if (typeof id === 'string') topEnd.set(id, offset + node.nodeSize);
  });

  // Node borders + per-block Discard pills (any depth).
  doc.descendants((node, pos) => {
    const id = node.attrs?.id;
    if (typeof id !== 'string') return true;
    const cls = added.has(id) ? 'is-diff-added' : changed.has(id) ? 'is-diff-changed' : null;
    if (cls) {
      decos.push(Decoration.node(pos, pos + node.nodeSize, { class: cls }));
      const pill = actionButton(
        'Discard',
        'Discard this change',
        'discard',
        id,
        'diff-pill diff-pill-discard',
      );
      decos.push(
        Decoration.widget(pos + 1, pill, { side: -1, key: `act:${id}`, ignoreSelection: true }),
      );
    }
    return true;
  });

  // Removed ghosts — placed after their anchor (or at doc start). `side` keeps
  // multiple ghosts sharing an anchor in document order.
  overlay.removed.forEach((g, i) => {
    const pos = g.afterId != null ? (topEnd.get(g.afterId) ?? 0) : 0;
    decos.push(
      Decoration.widget(pos, ghostWidget(g), {
        side: 100 + i,
        key: `ghost:${g.id}`,
        ignoreSelection: true,
      }),
    );
  });

  return DecorationSet.create(doc, decos);
}

export const DiffReview = Extension.create({
  name: 'diffReview',

  addProseMirrorPlugins() {
    return [
      new Plugin<DiffReviewState>({
        key: diffReviewKey,
        state: {
          init: () => ({ overlay: null, deco: DecorationSet.empty }),
          apply(tr, value, _old, newState) {
            const meta = tr.getMeta(diffReviewKey) as DiffOverlay | null | undefined;
            if (meta !== undefined) {
              return {
                overlay: meta,
                deco: meta ? decorate(newState.doc, meta) : DecorationSet.empty,
              };
            }
            // Positions shift on edits — rebuild against the new doc (ids stable).
            if (tr.docChanged && value.overlay) {
              return { ...value, deco: decorate(newState.doc, value.overlay) };
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            return diffReviewKey.getState(state)?.deco ?? null;
          },
        },
      }),
    ];
  },
});
