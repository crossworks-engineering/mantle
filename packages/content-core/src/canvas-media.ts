/**
 * The canvas media contract (task a265178d): which Files a Present canvas
 * may play or show through `mantle.media`, shared by the save step (the
 * content layer derives `meta.assets` here), the frame's helper (share-ui
 * canvas-frame-html), the host that answers its calls (share-ui
 * canvas-sandbox) and the open link's asset check. Pure: no server or
 * browser dependency.
 *
 * A canvas runs sandboxed with no network. It asks its PARENT for a file's
 * bytes by id; the parent fetches them with its own credential and hands
 * them over, and the frame makes a blob: URL of them. One rule decides
 * which ids it may ask for: those its saved source DECLARES, in a head tag
 * (`<meta name="canvas:assets" content="id id ...">`) or, for a diagram
 * template canvas, in its data's `fileId` fields. The save keeps only the
 * declared files the saver reads (the content layer); every play is
 * checked again as the viewer (their own file read) or, on an open link,
 * against the link's media switch.
 */

import { UUID_RE } from './uuid';

/** The most file ids one canvas declares. */
export const CANVAS_ASSETS_MAX = 500;

/** The largest file the host hands a canvas. */
export const CANVAS_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

/** How many media calls of one frame may wait at once. */
export const CANVAS_MEDIA_IN_FLIGHT_MAX = 4;

/** How long the host waits for one file, and the frame for the host. */
export const CANVAS_MEDIA_CALL_TIMEOUT_MS = 60_000;

/** The types the host hands a canvas: mp3 and ogg sound, and raster
 *  pictures. Never SVG or HTML: a canvas gets bytes it can only play or
 *  draw, never a document that would run. */
export const CANVAS_MEDIA_MIMES = [
  'audio/mpeg',
  'audio/ogg',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

/** A file type the host hands a canvas, from a response's content-type
 *  (parameters dropped), or null. */
export function canvasMediaMime(contentType: string | null | undefined): string | null {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return (CANVAS_MEDIA_MIMES as readonly string[]).includes(base) ? base : null;
}

/** The words a frame hears for any file it may not have: one answer for
 *  "not declared", "not readable" and "gone", so a canvas learns nothing
 *  about a file it was not given. */
export const CANVAS_MEDIA_NO_ACCESS = 'no access to this file';

/** A file id as a canvas names one: a uuid, either case. */
export function isCanvasAssetId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** The meta tag a canvas declares its files in. */
export const CANVAS_ASSETS_META = 'canvas:assets';

/** The opening tag of a diagram template canvas's data block (diagram-
 *  templates canvas.ts DATA_ID, 'diagram-data'), and its head marker. */
const TEMPLATE_DATA_OPEN = '<script type="application/json" id="diagram-data">';
const TEMPLATE_MARKER = '<meta name="diagram:template"';

/** How far into a template's data the `fileId` fields are looked for. */
const TEMPLATE_DATA_DEPTH = 8;

/** What a canvas declares: the valid ids (lower case, de-duplicated, in
 *  order, at most CANVAS_ASSETS_MAX), the tokens that are not uuids, and
 *  whether it declared more than the cap. */
export type CanvasAssetDeclaration = { ids: string[]; bad: string[]; over: boolean };

/** The `fileId` values (uuids) of a template canvas's data, at any depth
 *  up to TEMPLATE_DATA_DEPTH: the D5 picture ids. */
function templateFileIds(html: string): string[] {
  if (!html.includes(TEMPLATE_MARKER)) return [];
  const at = html.indexOf(TEMPLATE_DATA_OPEN);
  const end = at < 0 ? -1 : html.indexOf('</script>', at + TEMPLATE_DATA_OPEN.length);
  if (end < 0) return [];
  let data: unknown;
  try {
    data = JSON.parse(html.slice(at + TEMPLATE_DATA_OPEN.length, end));
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > TEMPLATE_DATA_DEPTH || out.length > CANVAS_ASSETS_MAX || !v) return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'fileId' && typeof x === 'string') out.push(x);
      else walk(x, depth + 1);
    }
  };
  walk(data, 0);
  return out;
}

/** The file ids a canvas declares: its `canvas:assets` head tag (`tag`,
 *  the meta's content as parseCanvasHead reads it, or null) and a template
 *  canvas's data `fileId` fields. */
export function canvasAssetDeclaration(html: string, tag: string | null): CanvasAssetDeclaration {
  const tokens = [
    ...(tag ?? '')
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean),
    ...templateFileIds(html),
  ];
  const ids: string[] = [];
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (!UUID_RE.test(t)) {
      if (bad.length < 20) bad.push(t.slice(0, 60));
      continue;
    }
    const id = t.toLowerCase();
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids: ids.slice(0, CANVAS_ASSETS_MAX), bad, over: ids.length > CANVAS_ASSETS_MAX };
}

/** Literal ids a canvas passes to `mantle.media.url/image/release('<id>')`
 *  (a bounded scan per call site). */
function literalMediaIds(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(
    /mantle\.media\.(?:url|image|release)\(\s*["'`]([0-9a-fA-F-]{36})["'`]/g,
  )) {
    if (UUID_RE.test(m[1]!)) out.add(m[1]!.toLowerCase());
  }
  return [...out];
}

/**
 * What is wrong with a canvas's declaration, found before it is saved:
 * `problems` refuse the save (a token that is not a file id, more than the
 * cap), `warnings` do not (an id the canvas passes to `mantle.media` by
 * name that it never declared: that call will be refused). Each names the
 * fix. The read check (the saver reads every declared file) is the content
 * layer's, not this.
 */
export function canvasAssetProblems(
  html: string,
  decl: CanvasAssetDeclaration,
): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  if (decl.bad.length) {
    problems.push(
      `${CANVAS_ASSETS_META} holds ${decl.bad.map((b) => `'${b}'`).join(', ')}: list file ids only (uuids, from file_list), separated by spaces.`,
    );
  }
  if (decl.over) {
    problems.push(
      `${CANVAS_ASSETS_META} declares more than ${CANVAS_ASSETS_MAX} files. Split the canvas, or declare fewer.`,
    );
  }
  const declared = new Set(decl.ids);
  const missing = literalMediaIds(html).filter((id) => !declared.has(id));
  const warnings = missing.length
    ? [
        `mantle.media is called with ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' and more' : ''}, not in ${CANVAS_ASSETS_META}: those calls will be refused. Add the ids to <meta name="${CANVAS_ASSETS_META}" content="id id ...">.`,
      ]
    : [];
  return { problems, warnings };
}

/** A media call the host takes: its call id and the file it asks for
 *  (lower case). */
export type CanvasMediaRequest = { id: number; file: string };

/** Read a frame's `{v:1, kind:'media', n, id, file}` message: the request,
 *  or the call id to refuse (null: drop it, nothing to answer to). The
 *  nonce and the frame are checked before (acceptsDataMessage). */
export function readCanvasMediaMessage(
  raw: unknown,
): { ok: true; req: CanvasMediaRequest } | { ok: false; id: number | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, id: null };
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === 'number' && Number.isSafeInteger(m.id) && m.id > 0 ? m.id : null;
  if (id === null) return { ok: false, id: null };
  if (!isCanvasAssetId(m.file)) return { ok: false, id };
  return { ok: true, req: { id, file: m.file.toLowerCase() } };
}

/** The example clips the guide's canvas declares (placeholders: an agent
 *  puts its own file ids in). */
export const CANVAS_MEDIA_EXAMPLE_IDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
] as const;

/**
 * The how-to for `mantle.media`, one text for every reader: the
 * canvas_authoring skill (in-app agents) sets it in as a section, and
 * canvas_library 'media' (what an MCP client reads) answers it with a full
 * example canvas. Markdown, no heading of its own. The caps come from the
 * constants above, so the words never drift from the checks.
 */
export const CANVAS_MEDIA_HOWTO = `Only when a canvas plays sound or shows a picture kept in Files (narration clips, a photo). Anything small stays inline (a data: URL, inline SVG).

The frame gives every canvas \`mantle.media\` (no import, no network: the page around the canvas fetches the file as the viewer and hands the bytes in):

- \`await mantle.media.url(fileId)\`: a \`blob:\` URL of the file, for an \`<audio>\` or \`<img>\` \`src\`. One URL per file, kept until released.
- \`await mantle.media.image(fileId)\`: the same call, for pictures.
- \`mantle.media.release(fileId)\`: free the file's URL once it has played.

Rules:

- Declare every file in the head: \`<meta name="${CANVAS_ASSETS_META}" content="<file id> <file id> ...">\`, ids from \`file_list\` or \`speech_file_create\`, at most ${CANVAS_ASSETS_MAX}. A call for a file not declared is refused. The save keeps only the files you can read, and its reply says which it left out and who cannot play them.
- mp3 or ogg sound, png, jpeg or webp pictures, at most ${CANVAS_MEDIA_MAX_BYTES / (1024 * 1024)} MB each. Never a file URL in the source: it is refused.
- Every call can reject: a viewer who cannot read the file, an open link whose media is off, a picture of the canvas (poster, export: no sound there). Always keep a way on without it: captions, \`speechSynthesis\`, or the next slide.
- Browsers play sound only from a click, and iPhone and iPad allow it per player. Use ONE shared player: ask for the first clip's URL before the click, set its \`src\` and call \`play()\` inside the click handler itself (no \`await\` before it), then change \`src\` and \`play()\` again on \`ended\` for each next clip. A new \`<audio>\` per clip stops after the first one there.
- Ask for the next clip while one plays; release the one that finished.

\`\`\`html
<button id="start" class="rounded-md bg-primary px-8 py-4 text-2xl text-primary-foreground">Start</button>
<p id="caption" class="text-3xl" aria-live="polite"></p>
<script type="module">
  // Each line's caption and clip; the same ids are in <meta name="${CANVAS_ASSETS_META}">.
  const lines = [
    { text: 'Welcome to the tour.', fileId: '${CANVAS_MEDIA_EXAMPLE_IDS[0]}' },
    { text: 'Here is the second stop.', fileId: '${CANVAS_MEDIA_EXAMPLE_IDS[1]}' },
  ];
  const player = new Audio();
  const caption = document.getElementById('caption');
  const asked = new Map();
  const urlOf = (line) => {
    if (!asked.has(line.fileId)) asked.set(line.fileId, mantle.media.url(line.fileId).catch(() => null));
    return asked.get(line.fileId);
  };
  let at = 0;
  const first = await urlOf(lines[0]); // fetched before the click: no gesture needed for that
  function speak(text) {
    if (!('speechSynthesis' in window)) return void setTimeout(next, 2500);
    const u = new SpeechSynthesisUtterance(text);
    u.onend = next;
    speechSynthesis.speak(u);
  }
  function show(url) {
    const line = lines[at];
    caption.textContent = line.text;
    if (lines[at + 1]) urlOf(lines[at + 1]);
    if (!url) return speak(line.text);
    player.src = url;
    player.play().catch(() => speak(line.text));
  }
  async function next() {
    const done = lines[at];
    mantle.media.release(done.fileId);
    asked.delete(done.fileId);
    at += 1;
    if (at < lines.length) show(await urlOf(lines[at]));
  }
  player.addEventListener('ended', next);
  // play() inside the click itself: this is what unlocks the one player.
  document.getElementById('start').addEventListener('click', () => show(first), { once: true });
</script>
\`\`\``;
