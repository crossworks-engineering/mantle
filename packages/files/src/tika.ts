/**
 * Apache Tika client — the third-tier document parser.
 *
 * The first tier is our in-process parsers (pdf-parse / mammoth / SheetJS in
 * `./pdf`, `./docx`, `./xlsx`). The second tier is the vision worker (OCR for
 * scanned PDFs and images, see apps/agent/src/extractor.ts `ocrIngestPdfNode`).
 * This third tier handles the long tail of formats neither of those covers:
 * `.odt` / `.ods` / `.odp` (LibreOffice), `.pptx` / `.ppt` (PowerPoint),
 * `.doc` (legacy Word), `.rtf`, `.epub`, and whatever else Tika knows about.
 *
 * Self-hosted (`apache/tika:3.3.0.0` in docker-compose), so bytes never leave
 * the VPS — same privacy property as the rest of the stack. Stateless: a
 * crash/restart loses no state.
 *
 * Kept behind a separate entry point (`@mantle/files/tika`) with a lazy
 * dynamic import, so apps/web bundling doesn't pull this in for paths that
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
  const env = process.env.TIKA_URL?.trim();
  return (env && env.length > 0 ? env : DEFAULT_TIKA_URL).replace(/\/$/, '');
}

/**
 * Send bytes to Tika and get plain text back. Returns `''` on any failure —
 * Tika down, timeout, non-2xx response (with the exception below), network
 * blip, unsupported bytes — so the caller (parseDocumentBytes) can fall
 * through to the standard "no extractable text" path.
 *
 * **HTTP 422 with body** is treated as PARTIAL SUCCESS. Tika's
 * SecureContentHandler raises on inputs that expand past its built-in
 * zip-bomb ratio (~100:1 of input bytes → output chars), throwing a SAX
 * exception mid-parse. Tika then returns 422 with whatever content it had
 * already streamed to the writer. Real bug case: a legit 8.5 KB EPUB whose
 * 1 MB body is mostly repeated Lorem ipsum trips the ratio and silently
 * indexed as just its filename. We now ACCEPT the partial body when it's
 * under MAX_PARTIAL_BODY_BYTES — large enough for any genuine document,
 * small enough that a true zip bomb can't flood the LLM/embedder.
 *
 * `mimeType` is a hint passed as the request's `Content-Type`. Tika
 * auto-detects from magic bytes when omitted, but supplying the type when we
 * know it (from the file extension) helps disambiguation on tricky formats
 * like .doc vs .docx.
 */
export async function parseTikaBytes(
  bytes: Buffer,
  opts?: { mimeType?: string; timeoutMs?: number },
): Promise<string> {
  const url = `${tikaUrl()}/tika`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'text/plain' };
    if (opts?.mimeType) headers['Content-Type'] = opts.mimeType;
    // TS 5.9 made Uint8Array generic in `ArrayBufferLike`, which doesn't
    // structurally match the DOM lib's `BodyInit` (it expects
    // `Uint8Array<ArrayBuffer>` specifically). The runtime accepts Buffer
    // directly — Node's undici fetch handles it natively — so the safest
    // fix is the type-only escape hatch through `unknown`. No copy, no
    // wrapping in Blob.
    const res = await fetch(url, {
      method: 'PUT',
      body: bytes as unknown as BodyInit,
      headers,
      signal: ac.signal,
    });
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
 * ("Apache Tika 3.3.0"). Useful for the operator dashboard — at-a-glance
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
