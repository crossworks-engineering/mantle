/**
 * The canvas data store's contract (DWG phase 7a): what a Present canvas may
 * keep through `mantle.data`, shared by the frame's helper (share-ui
 * canvas-frame-html), the host that forwards its calls (share-ui
 * canvas-sandbox), the brain's route and the content layer. Pure: no server
 * or browser dependency.
 *
 * A canvas runs sandboxed, with no network, no cookies and no storage. It
 * asks its PARENT page over postMessage; the parent forwards each call to
 * the brain as the signed-in user, and binds the canvas: a message names
 * neither a canvas nor a login. So everything a message carries is hostile
 * until these checks pass, on the host and again on the brain.
 *
 * Two buckets, on the canvas's own item rights:
 *  - `shared`: every reader of the canvas reads it; only a user with Write on
 *    the canvas writes it (the right a source save asks).
 *  - `mine`: every reader writes their own entries only. A plain reader reads
 *    their own; a user with Write on the canvas (its owner too) reads
 *    everyone's, may remove any of them and may clear the canvas's data.
 *
 * Who wrote an entry: a `shared` entry shows the writer's name to every
 * reader, and the writer's login id only to a user with Write on the canvas.
 */

import { UUID_RE } from './uuid';

export const CANVAS_DATA_BUCKETS = ['shared', 'mine'] as const;
export type CanvasDataBucket = (typeof CANVAS_DATA_BUCKETS)[number];

/** One value, in UTF-8 bytes, as the brain stores it (its JSON text with a
 *  space after each `,` and `:`), which is what every cap counts. The
 *  compact text checked here is never longer, so it is a first bound; the
 *  brain's definer has the last word. */
export const CANVAS_DATA_VALUE_MAX_BYTES = 64 * 1024;
/** All values of one canvas, both buckets, every login. */
export const CANVAS_DATA_CANVAS_MAX_BYTES = 1024 * 1024;
/** Entries of one canvas, both buckets, every login. */
export const CANVAS_DATA_CANVAS_MAX_KEYS = 1000;
/** One login's `mine` entries on one canvas: no single reader fills the
 *  canvas's budget for everyone else. */
export const CANVAS_DATA_MINE_MAX_BYTES = 256 * 1024;
export const CANVAS_DATA_MINE_MAX_KEYS = 200;
/** Every login's `mine` entries together on one canvas: 75% of the canvas's
 *  caps, so readers never fill it and `shared` always keeps a quarter. */
export const CANVAS_DATA_MINE_ALL_MAX_BYTES = (CANVAS_DATA_CANVAS_MAX_BYTES * 3) / 4;
export const CANVAS_DATA_MINE_ALL_MAX_KEYS = (CANVAS_DATA_CANVAS_MAX_KEYS * 3) / 4;
/** How deep a value's arrays and objects may nest. */
export const CANVAS_DATA_MAX_DEPTH = 64;

/** A key: 1 to 128 characters, a letter or digit first, then letters,
 *  digits and `_ - . : /`. Plain enough to show, log and put in a URL. */
export const CANVAS_DATA_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

/** How long the host waits on the brain for one forwarded call, and the
 *  frame on the host. */
export const CANVAS_DATA_CALL_TIMEOUT_MS = 30_000;

/** The operations a canvas may ask for. */
export const CANVAS_DATA_OPS = ['get', 'set', 'delete', 'list', 'info', 'clear'] as const;
export type CanvasDataOp = (typeof CANVAS_DATA_OPS)[number];

/** One stored entry as the brain answers it. `by` is the login that owns a
 *  `mine` entry (or last wrote a `shared` one). Its `id` is left out of a
 *  `shared` entry for a reader without Write on the canvas: the name only. */
export type CanvasDataEntry = {
  key: string;
  value: unknown;
  updatedAt: string;
  by?: { id?: string; name: string | null };
};

/** What the store says about the reader of this canvas. */
export type CanvasDataInfo = {
  /** The reader may write the `shared` bucket (Write on the canvas), remove
   *  another viewer's `mine` entry and clear the canvas's data. */
  canWriteShared: boolean;
  /** The reader may list everyone's `mine` entries (Write on the canvas). */
  readsEveryone: boolean;
  /** The reader's own login id: their `mine` entries carry it in `by`. */
  me: string | null;
  /** The canvas is a read-only copy: nothing is written. */
  readOnly: boolean;
};

export function isCanvasDataBucket(v: unknown): v is CanvasDataBucket {
  return typeof v === 'string' && (CANVAS_DATA_BUCKETS as readonly string[]).includes(v);
}

export function isCanvasDataKey(v: unknown): v is string {
  return typeof v === 'string' && CANVAS_DATA_KEY_RE.test(v);
}

/** An entry's `by.id`, as `delete(key, { bucket: 'mine', by })` names it:
 *  a uuid as the store gives it, lowercase only. */
export function isCanvasDataLoginId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v) && v === v.toLowerCase();
}

export function isCanvasDataOp(v: unknown): v is CanvasDataOp {
  return typeof v === 'string' && (CANVAS_DATA_OPS as readonly string[]).includes(v);
}

/** UTF-8 byte length of a string, without a Buffer or a TextEncoder (both
 *  sides run it). */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        n += 4;
        i++;
      } else n += 3;
    } else n += 3;
  }
  return n;
}

/** Whether a JSON value nests deeper than `max` arrays and objects (walked
 *  without recursion: the value is at most a value's size). */
function nestsDeeper(value: unknown, max: number): boolean {
  const stack: { v: unknown; d: number }[] = [{ v: value, d: 0 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (v === null || typeof v !== 'object') continue;
    if (d + 1 > max) return true;
    for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object') stack.push({ v: child, d: d + 1 });
    }
  }
  return false;
}

/**
 * A value's JSON text, checked: JSON only (what JSON.parse gives back), at
 * most CANVAS_DATA_VALUE_MAX_BYTES, nested at most CANVAS_DATA_MAX_DEPTH. `json` is the text a caller sent; the
 * answer is the parsed value and its compact text, which the brain's
 * definer takes (and sizes again as it stores it: what the caps count).
 */
export function readCanvasDataJson(
  json: unknown,
): { ok: true; value: unknown; text: string; bytes: number } | { ok: false; error: string } {
  if (typeof json !== 'string') return { ok: false, error: 'value must be JSON' };
  // A cheap first bound: a string is never fewer bytes than characters.
  if (json.length > CANVAS_DATA_VALUE_MAX_BYTES) return { ok: false, error: tooBig() };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, error: 'value must be JSON' };
  }
  return canvasDataValue(value);
}

/** A parsed value, checked as readCanvasDataJson checks its text. */
export function canvasDataValue(
  value: unknown,
): { ok: true; value: unknown; text: string; bytes: number } | { ok: false; error: string } {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return { ok: false, error: 'value must be JSON' };
  }
  if (text === undefined) return { ok: false, error: 'value must be JSON' };
  const bytes = utf8Bytes(text);
  if (bytes > CANVAS_DATA_VALUE_MAX_BYTES) return { ok: false, error: tooBig() };
  const parsed = JSON.parse(text) as unknown;
  if (nestsDeeper(parsed, CANVAS_DATA_MAX_DEPTH)) {
    return { ok: false, error: `value nests deeper than ${CANVAS_DATA_MAX_DEPTH} levels` };
  }
  return { ok: true, value: parsed, text, bytes };
}

/** The refusal for a value over CANVAS_DATA_VALUE_MAX_BYTES, here or as
 *  the brain stores it. */
export const CANVAS_DATA_TOO_BIG_ERROR = `value is over ${CANVAS_DATA_VALUE_MAX_BYTES / 1024} KB`;

function tooBig(): string {
  return CANVAS_DATA_TOO_BIG_ERROR;
}

/** The refusal when a write would pass a cap, the same words everywhere. */
export const CANVAS_DATA_FULL_ERROR =
  `the canvas's data is full: ${CANVAS_DATA_CANVAS_MAX_BYTES / 1024 / 1024} MB and ` +
  `${CANVAS_DATA_CANVAS_MAX_KEYS} entries per canvas (viewers' own entries together ` +
  `${CANVAS_DATA_MINE_ALL_MAX_BYTES / 1024} KB and ${CANVAS_DATA_MINE_ALL_MAX_KEYS}), ` +
  `${CANVAS_DATA_MINE_MAX_BYTES / 1024} KB and ${CANVAS_DATA_MINE_MAX_KEYS} entries of your own`;

/**
 * How a canvas author uses the store, ONE text for every author: the
 * canvas_authoring skill (in-app agents) sets it in as a section, and
 * canvas_library 'data' (what an MCP client reads) answers it with a full
 * example canvas. Markdown, no heading of its own. The caps come from the
 * constants above, so the words never drift from the checks.
 */
export const CANVAS_DATA_HOWTO = `Only when a canvas must keep something people add (notes, suggestions, votes, a saved layout, meeting marks). A canvas that only shows things stays plain: no store calls.

The frame gives every canvas \`mantle.data\` (no import, no network: the page around the canvas saves it for the signed-in viewer, for this canvas only):

- \`await mantle.data.get(key, { bucket })\`: the value, or \`undefined\`.
- \`await mantle.data.set(key, value, { bucket })\`: save (made or replaced).
- \`await mantle.data.delete(key, { bucket, by })\`: \`by\` (an entry's \`by.id\`) removes another viewer's \`'mine'\` entry: Write only.
- \`await mantle.data.list({ bucket, everyone })\`: \`[{ key, value, updatedAt, by: { id, name } }]\`; a \`'shared'\` entry's \`by.id\` only for a user with Write.
- \`await mantle.data.clear()\`: remove every entry of the canvas, both buckets: Write only.
- \`await mantle.data.info()\`: \`{ canWriteShared, readsEveryone, me, readOnly }\`.

Buckets (\`bucket\` defaults to \`'shared'\`):

- \`'shared'\`: one value per key for everyone who can open the canvas. Only a user with Write on the canvas may write it (layouts, meeting marks).
- \`'mine'\`: each viewer's own entries; any viewer writes their own (suggestions, votes). A user with Write on the canvas reads everyone's with \`list({ bucket: 'mine', everyone: true })\`; others see only their own.

Rules:

- Values are small JSON: at most ${CANVAS_DATA_VALUE_MAX_BYTES / 1024} KB each, ${CANVAS_DATA_CANVAS_MAX_BYTES / 1024 / 1024} MB and ${CANVAS_DATA_CANVAS_MAX_KEYS} entries per canvas (\`'mine'\` together at most ${CANVAS_DATA_MINE_ALL_MAX_BYTES / 1024} KB and ${CANVAS_DATA_MINE_ALL_MAX_KEYS}), ${CANVAS_DATA_MINE_MAX_BYTES / 1024} KB and ${CANVAS_DATA_MINE_MAX_KEYS} entries per viewer in \`'mine'\`. Keys: letters, digits and \`_ - . : /\`, up to 128, a letter or digit first.
- Data arrives after the first paint: draw the canvas first, then fill it in. The picture a save returns, the poster and exports show the canvas with no data.
- Every call returns a promise that can reject (no right, full, offline): catch it and say so on the canvas; never lose what the viewer typed.
- Another viewer wrote what you read: show it as text (\`textContent\`), never as HTML.
- Never store secrets, passwords or keys. A photo or a big file goes in Files; keep only its id here.
- Saving data never changes the canvas or makes a new version of it.
- A canvas with an element whose \`id\` or \`name\` is \`mantle\` has no \`mantle.data\`: the name stays that element's.

\`\`\`html
<textarea id="notes" class="h-40 w-full rounded-md border border-border bg-card p-4 text-xl"></textarea>
<ul id="ideas" class="text-xl"></ul>
<script type="module">
  const notes = document.getElementById('notes');
  const info = await mantle.data.info();
  notes.readOnly = !info.canWriteShared;
  notes.value = (await mantle.data.get('notes')) ?? '';
  notes.addEventListener('change', () =>
    mantle.data.set('notes', notes.value).catch((e) => (notes.title = e.message)));
  // A viewer's suggestion: their own entry in 'mine'.
  const suggest = (text) => mantle.data.set('idea-' + Date.now(), { text }, { bucket: 'mine' });
  const ideas = await mantle.data.list({ bucket: 'mine', everyone: info.readsEveryone });
  for (const e of ideas) {
    const li = document.createElement('li');
    li.textContent = (e.by?.name ?? 'Someone') + ': ' + e.value.text;
    document.getElementById('ideas').append(li);
  }
</script>
\`\`\``;
