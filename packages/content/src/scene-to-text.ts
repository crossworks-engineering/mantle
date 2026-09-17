/**
 * Excalidraw scene → plaintext, for the extractor + FTS (`draws.scene_text`).
 *
 * Deliberately our own walker rather than the package's `getTextFromElements`
 * (a 12-line join over text elements): the extractor reads structure, and a
 * whiteboard has structure worth surfacing —
 *
 *   - frames become `#` headings, with their member elements grouped under
 *     them (the chunker then uses frames as section context, like doc
 *     headings);
 *   - a shape's bound label ("Server", "Postgres") is the shape's meaning;
 *   - a labelled arrow between two labelled shapes is a RELATION, rendered
 *     `A -> B: label` — the most brain-worthy content on an architecture
 *     sketch.
 *
 * Pure function over plain JSON, no excalidraw import (the package is
 * browser-oriented; this runs in the extractor). Defensive about shape: the
 * scene is client-supplied jsonb, so every access is guarded.
 */

type El = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function elements(scene: unknown): El[] {
  if (!scene || typeof scene !== 'object') return [];
  const els = (scene as Record<string, unknown>).elements;
  if (!Array.isArray(els)) return [];
  return els.filter((e): e is El => !!e && typeof e === 'object' && !(e as El).isDeleted);
}

/** The text bound INSIDE a container shape (its label), if any. */
function labelMap(els: El[]): Map<string, string> {
  const byContainer = new Map<string, string>();
  for (const el of els) {
    if (el.type !== 'text') continue;
    const containerId = str(el.containerId);
    const text = str(el.text).trim();
    if (containerId && text) byContainer.set(containerId, text);
  }
  return byContainer;
}

/** A human name for an arrow endpoint: the shape's label, or — when the arrow
 *  binds directly to a standalone text element — that text itself. */
function endpointName(id: string, byId: Map<string, El>, labels: Map<string, string>): string {
  const label = labels.get(id);
  if (label) return label;
  const el = byId.get(id);
  if (el?.type === 'text') return str(el.text).trim();
  return '';
}

function boundElementId(el: El, key: 'startBinding' | 'endBinding'): string {
  const binding = el[key];
  if (!binding || typeof binding !== 'object') return '';
  return str((binding as El).elementId);
}

export function sceneToText(scene: unknown): string {
  const els = elements(scene);
  if (els.length === 0) return '';

  const byId = new Map<string, El>();
  for (const el of els) {
    const id = str(el.id);
    if (id) byId.set(id, el);
  }
  const labels = labelMap(els);

  // Group content lines by frame (unframed first, then frames in scene
  // order). A line lands in the group of the element that produced it.
  const frames = els.filter((el) => el.type === 'frame' || el.type === 'magicframe');
  const groups = new Map<string, string[]>(); // frameId ('' = unframed) → lines
  const push = (frameId: string, line: string) => {
    const t = line.trim();
    if (!t) return;
    const key = byId.has(frameId) ? frameId : '';
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  };

  for (const el of els) {
    const frameId = str(el.frameId);
    if (el.type === 'text') {
      // A container-bound text is its shape's label — surfaced via the shape
      // below (and via relations); don't emit it twice.
      if (str(el.containerId)) continue;
      push(frameId, str(el.text));
    } else if (el.type === 'arrow' || el.type === 'line') {
      const start = endpointName(boundElementId(el, 'startBinding'), byId, labels);
      const end = endpointName(boundElementId(el, 'endBinding'), byId, labels);
      const label = labels.get(str(el.id)) ?? '';
      if (start && end) {
        push(frameId, label ? `${start} -> ${end}: ${label}` : `${start} -> ${end}`);
      } else if (label) {
        // A floating labelled arrow still carries its label's meaning.
        push(frameId, label);
      }
    } else if (el.type !== 'frame' && el.type !== 'magicframe') {
      // Any container shape (rectangle / ellipse / diamond / embeddable / …):
      // its bound label is its meaning.
      const label = labels.get(str(el.id));
      if (label) push(frameId, label);
    }
  }

  const sections: string[] = [];
  const unframed = groups.get('');
  if (unframed?.length) sections.push(unframed.join('\n'));
  for (const frame of frames) {
    const id = str(frame.id);
    const name = str(frame.name).trim();
    const lines = groups.get(id) ?? [];
    if (!name && lines.length === 0) continue;
    sections.push([`# ${name || 'Frame'}`, ...lines].join('\n'));
  }
  return sections.join('\n\n');
}
