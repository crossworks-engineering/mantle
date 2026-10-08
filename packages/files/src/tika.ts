import { env } from '@mantle/config';
/**
 * Apache Tika client — the third-tier document parser.
 *
 * The first tier is our in-process parsers (pdf-parse / mammoth / exceljs in
 * `./pdf`, `./docx`, `./xlsx`). The second tier is the vision worker (OCR for
 * scanned PDFs and images, see server/api/src/extractor.ts `ocrIngestPdfNode`).
 * This third tier handles the long tail of formats neither of those covers:
 * `.odt` / `.ods` / `.odp` (LibreOffice), `.pptx` / `.ppt` (PowerPoint),
 * `.doc` (legacy Word), `.rtf`, `.epub`, and whatever else Tika knows about.
 *
 * Self-hosted (`apache/tika:4.1.0-1` in docker-compose), so bytes never leave
 * the VPS — same privacy property as the rest of the stack. Stateless: a
 * crash/restart loses no state.
 *
 * Kept behind a separate entry point (`@mantle/files/tika`) with a lazy
 * dynamic import, so server/web bundling doesn't pull this in for paths that
 * never hit a Tika-needed format. The wrapper is **never-throws** — every
 * failure mode (Tika down, network blip, timeout, unsupported bytes, 4xx /
 * 5xx response) returns `''`, which the caller treats as "no extractable
 * text" (the `no_text_layer` honest skip).
 */

/** Default endpoint for dev (Tika exposed on the host) and tests. In prod
 *  docker-compose, the web/agent/workers reach Tika by service name via the
 *  TIKA_URL env (set to `http://tika:9998`). */
const DEFAULT_TIKA_URL = 'http://127.0.0.1:9998';

/** Per-request timeout. Tika's cold start can take a few seconds, and large
 *  documents (long PPTX decks, complex spreadsheets) parse-take a while. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Soft cap on the body we'll accept from a partial-success Tika response
 *  (status 422 with content). Tika's zip-bomb defense throws SAX exceptions
 *  mid-parse on any input that expands beyond its built-in ratio threshold
 *  (~100:1) — legit EPUBs/PPTXs full of repeated text trip this. The body
 *  the response carries is the parsed-so-far text and is usually fine to
 *  index. We cap it because a TRUE zip bomb would also arrive via this
 *  path, and pumping megabytes of attacker-controlled text into the LLM /
 *  embedder is the harm we don't want. 5 MB ≫ any realistic document and
 *  ≪ the threshold at which an evil zip can do damage. */
const MAX_PARTIAL_BODY_BYTES = 5_000_000;

function tikaUrl(): string {
  const configured = env('TIKA_URL')?.trim();
  return (configured && configured.length > 0 ? configured : DEFAULT_TIKA_URL).replace(/\/$/, '');
}

/** Tika 4 names the output format in the path; the bare `/tika` now answers
 *  Markdown and ignores `Accept`. */
const TIKA4_PATH = { 'text/plain': '/tika/text', 'text/html': '/tika/html' } as const;
type TikaAccept = keyof typeof TIKA4_PATH;

/** Longest single pause we take on a 429 before asking again. */
const MAX_BACKOFF_MS = 5_000;

/**
 * PUT with Tika 4's backpressure honoured. Tika 4 parses in a fixed pool of
 * forked JVMs (`pipes.numClients`, 1 in our compose), so a second document
 * that arrives while the pool is busy is NOT a failure: the server answers
 * 429 with `Retry-After`. We wait and ask again until the caller's deadline.
 * Without this, two uploads landing together would turn the second one into
 * a silent `no_text_layer` skip. Every other status goes back to the caller.
 */
async function putUntilServed(
  url: string,
  bytes: Buffer,
  headers: Record<string, string>,
  signal: AbortSignal,
  deadline: number,
): Promise<Response> {
  for (;;) {
    // TS 5.9 made Uint8Array generic in `ArrayBufferLike`, which doesn't
    // structurally match the DOM lib's `BodyInit` (it expects
    // `Uint8Array<ArrayBuffer>` specifically). The runtime accepts Buffer
    // directly (Node's undici fetch handles it natively), so the safest
    // fix is the type-only escape hatch through `unknown`. No copy, no
    // wrapping in Blob.
    const res = await fetch(url, {
      method: 'PUT',
      body: bytes as unknown as BodyInit,
      headers,
      signal,
    });
    if (res.status !== 429) return res;
    await res.body?.cancel();
    const retryAfterS = Number(res.headers.get('retry-after'));
    const waitMs = Math.min(
      Number.isFinite(retryAfterS) && retryAfterS > 0 ? retryAfterS * 1000 : 1_000,
      MAX_BACKOFF_MS,
    );
    if (Date.now() + waitMs >= deadline) return res;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/** Did a Tika 4 raw endpoint answer? Those always carry a `text/*` type. A
 *  Tika 3 server also has `/tika/text` and `/tika/html`, but there they mean
 *  "metadata + content as JSON", and its 422 has no body type at all. */
function isTika4RawAnswer(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').toLowerCase().startsWith('text/');
}

/**
 * Send bytes to Tika and get plain text back. Returns `''` on any failure —
 * Tika down, timeout, non-2xx response (with the exception below), network
 * blip, unsupported bytes — so the caller (parseDocumentBytes) can fall
 * through to the standard "no extractable text" path.
 *
 * **Tika 4 first, Tika 3 as the fallback.** The 4.x call is `PUT /tika/text`
 * (or `/tika/html`): 4.x routes on the path and ignores `Accept`, so the old
 * `PUT /tika` + `Accept: text/plain` would now come back as Markdown. When the
 * server turns out to be a 3.x one (see `isTika4RawAnswer`) the same bytes go
 * again the 3.x way, `PUT /tika` with `Accept`. That keeps a box whose Tika
 * container has not rolled yet working, at the cost of one wasted parse.
 *
 * **HTTP 422 with body** is treated as PARTIAL SUCCESS. Tika's
 * SecureContentHandler raises on inputs that expand past its built-in
 * zip-bomb ratio (~100:1 of input bytes → output chars), throwing a SAX
 * exception mid-parse. Tika then returns 422 with whatever content it had
 * already streamed to the writer. Real bug case: a legit 8.5 KB EPUB whose
 * 1 MB body is mostly repeated Lorem ipsum trips the ratio and silently
 * indexed as just its filename. We now ACCEPT the partial body when it's
 * under MAX_PARTIAL_BODY_BYTES — large enough for any genuine document,
 * small enough that a true zip bomb can't flood the LLM/embedder. Tika 4
 * keeps this contract on its raw endpoints (its other errors are JSON
 * bodies on 400/413/429/503, none of which we salvage).
 *
 * `mimeType` is a hint passed as the request's `Content-Type`. Tika
 * auto-detects from magic bytes when omitted, but supplying the type when we
 * know it (from the file extension) helps disambiguation on tricky formats
 * like .doc vs .docx. Tika 4 treats it as a soft hint: it is kept only when
 * it agrees with (or refines) what the bytes say.
 *
 * `accept` picks Tika's rendering. The default `text/plain` is what every
 * text-extraction caller wants. `text/html` asks for Tika's XHTML instead,
 * which keeps document STRUCTURE — headings, and one `<table>` per sheet for
 * spreadsheets. `./legacy-sheet.ts` uses that to rebuild a legacy `.xls` as a
 * real workbook; nothing else should need it.
 */
export async function parseTikaBytes(
  bytes: Buffer,
  opts?: { mimeType?: string; timeoutMs?: number; accept?: TikaAccept },
): Promise<string> {
  const accept = opts?.accept ?? 'text/plain';
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const contentHeaders: Record<string, string> = {};
    if (opts?.mimeType) contentHeaders['Content-Type'] = opts.mimeType;
    let res = await putUntilServed(
      `${tikaUrl()}${TIKA4_PATH[accept]}`,
      bytes,
      contentHeaders,
      ac.signal,
      deadline,
    );
    if ((res.ok || res.status === 422) && !isTika4RawAnswer(res)) {
      await res.body?.cancel();
      res = await putUntilServed(
        `${tikaUrl()}/tika`,
        bytes,
        { ...contentHeaders, Accept: accept },
        ac.signal,
        deadline,
      );
    }
    if (res.ok) return (await res.text()).trim();
    // Status 422 with a non-empty body = Tika hit a safety guard mid-parse
    // (zip-bomb ratio, max-output-chars, …) but managed to stream useful
    // text first. Salvage it, capped, so a legit document isn't silently
    // discarded over a too-strict default threshold.
    if (res.status === 422) {
      const body = (await res.text()).trim();
      if (body.length > 0 && body.length <= MAX_PARTIAL_BODY_BYTES) return body;
    }
    return '';
  } catch {
    // Connection refused, ENOTFOUND, AbortError (timeout), any other surprise
    // — every Tika failure is "couldn't parse." Caller falls back.
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Embedded images out of the formats no in-process extractor covers — the
 * legacy binaries (.doc / .ppt / .xls / .rtf / .vsd) and anything else that
 * reaches tier 2.
 *
 * Tika's `/unpack/all` endpoint returns a ZIP of the document's embedded
 * resources. The two major versions lay that ZIP out differently:
 *
 *   - Tika 3: the parts under their own names (`docProps/thumbnail.jpeg`),
 *     plus two synthetic entries, `__TEXT__` and `__METADATA__`.
 *   - Tika 4: numbered entries (`1.jpg`, `2.png`), each with a
 *     `<name>.metadata.json` sidecar, and the container itself as entry
 *     `0.<ext>`. The real part name only survives in the sidecar.
 *
 * `unpackedImageEntries` reads both, so a box whose Tika has not rolled yet
 * still gets its images. This capability has been sitting in the stack
 * unused since Tika was introduced: same self-hosted container, same
 * never-leaves-the-box property as the text path.
 *
 * **No document order.** The endpoint hands back a bag of parts with no
 * indication of where each appeared, so ordinals here are archive order,
 * which is only loosely related to reading order. That's the honest ceiling
 * for these formats and the reason docx/pptx/xlsx/pdf all get their own
 * order-preserving extractors instead of routing through here.
 *
 * Never-throws, like every other function in this module: any failure (Tika
 * down, timeout, unparseable input) is an empty result.
 */
export async function unpackTikaImages(
  bytes: Buffer,
  ext: string,
  opts?: { timeoutMs?: number },
): Promise<import('./embedded-images').EmbeddedImage[]> {
  const url = `${tikaUrl()}/unpack/all`;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const { mimeForExt } = await import('./slug');
    const res = await putUntilServed(
      url,
      bytes,
      { 'Content-Type': mimeForExt(ext) },
      ac.signal,
      Date.now() + timeoutMs,
    );
    if (!res.ok) return [];
    const archive = Buffer.from(await res.arrayBuffer());
    if (archive.length === 0) return [];

    const { describeImageBytes } = await import('./embedded-images');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(archive);
    const out: import('./embedded-images').EmbeddedImage[] = [];
    for (const { name, partName } of await unpackedImageEntries(zip)) {
      // The Office-generated preview thumbnail is never part of the
      // document's content.
      if (/(^|\/)thumbnail\.\w+$/i.test(partName)) continue;
      const entry = zip.files[name];
      if (!entry || entry.dir) continue;
      const imgBytes = Buffer.from(await entry.async('uint8array'));
      if (imgBytes.length === 0) continue;
      const fallbackExt = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      out.push({
        bytes: imgBytes,
        ordinal: out.length + 1,
        ...describeImageBytes(imgBytes, fallbackExt),
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

type UnpackZip = Awaited<ReturnType<typeof import('jszip').loadAsync>>;

/**
 * The embedded parts in an `/unpack/all` ZIP, in archive order, each with the
 * part name the document gave it (what the thumbnail filter looks at).
 *
 * A Tika 4 archive is recognised by its `.metadata.json` sidecars. In it the
 * container is the one entry whose sidecar has no `tk:embedded-id`, and is
 * dropped; an entry without a readable sidecar keeps its numbered name. In a
 * Tika 3 archive the entry name IS the part name, and the synthetic `__…`
 * entries are dropped.
 */
async function unpackedImageEntries(
  zip: UnpackZip,
): Promise<Array<{ name: string; partName: string }>> {
  const names = Object.keys(zip.files).sort((a, b) => {
    // Tika 4 numbers entries `1.jpg … 10.png`; keep them in numeric order.
    const na = Number(/^(\d+)\./.exec(a)?.[1]);
    const nb = Number(/^(\d+)\./.exec(b)?.[1]);
    return Number.isFinite(na) && Number.isFinite(nb) && na !== nb ? na - nb : a.localeCompare(b);
  });
  const SIDECAR = '.metadata.json';
  if (!names.some((n) => n.endsWith(SIDECAR))) {
    return names.filter((n) => !n.startsWith('__')).map((n) => ({ name: n, partName: n }));
  }
  const out: Array<{ name: string; partName: string }> = [];
  for (const name of names) {
    if (name.endsWith(SIDECAR)) continue;
    let meta: Record<string, unknown> | null = null;
    try {
      const sidecar = await zip.file(name + SIDECAR)?.async('string');
      meta = sidecar ? (JSON.parse(sidecar) as Record<string, unknown>) : null;
    } catch {
      // Unreadable sidecar: keep the part, judged by its numbered name only.
    }
    // The container itself (Tika 4 always includes it): no embedded id.
    if (meta && meta['tk:embedded-id'] == null) continue;
    const partName =
      [
        meta?.['tk:embedded-relationship-id'],
        meta?.['tk:embedded-resource-path'],
        meta?.['tk:resource-name'],
      ].find((v): v is string => typeof v === 'string' && v.length > 0) ?? name;
    out.push({ name, partName });
  }
  return out;
}

/**
 * Cheap liveness check — used by callers that want to log a warning when
 * Tika is down rather than silently degrading. Hits Tika's `/version`
 * endpoint with a short timeout; returns true iff a 2xx came back.
 */
export async function tikaIsUp(timeoutMs = 2_000): Promise<boolean> {
  const url = `${tikaUrl()}/version`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: ac.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Health probe variant that also returns Tika's reported version string
 * ("Apache Tika 4.1.0"). Useful for the operator dashboard: at-a-glance
 * "up and on the expected version" without a second round-trip. Returns
 * null on any failure (down, timeout, non-2xx, empty body) — same
 * never-throws contract as the rest of this module.
 */
export async function tikaVersion(timeoutMs = 2_000): Promise<string | null> {
  const url = `${tikaUrl()}/version`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: ac.signal });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
