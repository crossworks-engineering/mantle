import { NET_TIMEOUTS, defineDomainError, timeoutSignal } from '@mantle/std';
import { documentsAvailable, gotenbergAuthHeader, gotenbergConfig } from './config';
import type { RouteDef } from './routes';

/**
 * The one HTTP client of the documents engine: fetch + FormData, basic
 * auth, the NET_TIMEOUTS deadline, and a clear error for each answer the
 * engine gives. Every surface goes through callGotenberg; nothing else in
 * the tree talks to the engine.
 */

/** The service is off, unwired, or did not answer: the caller hears 503
 *  and what the operator switches on. */
export class DocumentsUnavailableError extends Error {
  constructor(detail: string) {
    super(
      `The documents engine is not available: ${detail}. ` +
        'An admin switches it on in Settings > Services (the Documents service).',
    );
    this.name = 'DocumentsUnavailableError';
  }
}
defineDomainError(DocumentsUnavailableError, {
  reason:
    'the documents service is off or not answering; the message says what the admin switches on',
  status: 503,
});

/** The engine could not do the job (its 409): a page did not load, a
 *  resource failed, a console exception with failOnConsoleExceptions, a
 *  node the render cookie did not open (403/404 on the print origin). */
export class DocumentsRenderError extends Error {
  constructor(detail: string) {
    super(`The document could not be rendered: ${detail}`);
    this.name = 'DocumentsRenderError';
  }
}
defineDomainError(DocumentsRenderError, {
  reason: 'the engine refused the job (its 409); the message says why',
  status: 409,
});

/** The engine refused the form (its 400): a field value it does not take.
 *  The package checks every field first, so this is rare; the text is the
 *  engine's. */
export class DocumentsFormError extends Error {
  constructor(detail: string) {
    super(`The documents engine refused the request: ${detail}`);
    this.name = 'DocumentsFormError';
  }
}
defineDomainError(DocumentsFormError, {
  reason: 'the engine refused a form field (its 400); the message says which',
  status: 400,
});

/** The engine's body limit (413): the inputs together are too large. */
export class DocumentsTooLargeError extends Error {
  constructor(detail: string) {
    super(`The inputs are too large for the documents engine: ${detail}`);
    this.name = 'DocumentsTooLargeError';
  }
}
defineDomainError(DocumentsTooLargeError, {
  reason: 'the engine refused the body size (its 413)',
  status: 413,
});

/** The engine is busy (its 503: the queue is full or the job hit the
 *  engine's own timeout): try again shortly. */
export class DocumentsBusyError extends Error {
  constructor(detail: string) {
    super(`The documents engine is busy: ${detail}. Try again in a moment.`);
    this.name = 'DocumentsBusyError';
  }
}
defineDomainError(DocumentsBusyError, {
  reason: 'the engine queue is full or the job timed out (its 503); try again',
  status: 503,
});

/** Jobs this process has in flight at the engine at once. The engine runs
 *  two Chromium jobs and queues ten, so more would only wait there while
 *  this process holds their inputs and answers in memory (the audit's memory
 *  finding); the
 *  excess is refused as busy, which a caller retries. */
export const DOCUMENTS_MAX_IN_FLIGHT = 6;
/** Of those, how many one caller (a login, or the brain for a call with no
 *  login) may hold: one caller's minute of exports never takes every slot
 *  from the owner's Export button and the other logins. */
export const DOCUMENTS_MAX_IN_FLIGHT_PER_CALLER = 3;
let inFlight = 0;
const inFlightBy = new Map<string, number>();

/** Tests only. */
export function documentsInFlight(): number {
  return inFlight;
}

/** The Gotenberg-Output-Filename header takes Latin-1 only (undici's
 *  Headers refuses anything wider; the audit found it); the stem itself names the
 *  saved file, so the header carries an ASCII form of it, or nothing. */
export function headerSafeName(stem: string): string | null {
  const ascii = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]+/g, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  return ascii || null;
}

export type GotenbergAnswer = {
  bytes: Buffer;
  contentType: string;
  /** The filename the engine named (Content-Disposition), with its
   *  extension: the output kind decides it (pdf, zip, png, jpeg, webp). */
  filename: string | null;
};

/** The engine's error text, bounded, one line. */
function errorText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'no detail';
}

function filenameOf(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      return star[1];
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain?.[1] ?? null;
}

/**
 * POST one multipart form to a route of the engine and read the answer as
 * bytes. `outputName` is the stem the engine names the output after
 * (Gotenberg-Output-Filename; the engine adds the extension).
 */
export async function callGotenberg(
  route: Pick<RouteDef, 'path' | 'key'>,
  form: FormData,
  opts: { outputName?: string; timeoutMs?: number; callerKey?: string } = {},
): Promise<GotenbergAnswer> {
  if (!documentsAvailable()) {
    throw new DocumentsUnavailableError('the Documents service is switched off on this brain');
  }
  const cfg = gotenbergConfig();
  if (!cfg) throw new DocumentsUnavailableError('GOTENBERG_URL or GOTENBERG_PASSWORD is not set');
  const headers: Record<string, string> = { authorization: gotenbergAuthHeader(cfg) };
  const outputName = opts.outputName ? headerSafeName(opts.outputName) : null;
  if (outputName) headers['Gotenberg-Output-Filename'] = outputName;
  if (inFlight >= DOCUMENTS_MAX_IN_FLIGHT) {
    throw new DocumentsBusyError(
      `${DOCUMENTS_MAX_IN_FLIGHT} jobs are already running from this process`,
    );
  }
  const key = opts.callerKey ?? '';
  const mine = inFlightBy.get(key) ?? 0;
  if (mine >= DOCUMENTS_MAX_IN_FLIGHT_PER_CALLER) {
    throw new DocumentsBusyError(`${mine} of your jobs are already running`);
  }
  inFlight += 1;
  inFlightBy.set(key, mine + 1);
  const release = () => {
    inFlight -= 1;
    const left = (inFlightBy.get(key) ?? 1) - 1;
    if (left > 0) inFlightBy.set(key, left);
    else inFlightBy.delete(key);
  };
  let res: Response;
  try {
    res = await fetch(`${cfg.url}${route.path}`, {
      method: 'POST',
      headers,
      body: form,
      signal: timeoutSignal(opts.timeoutMs ?? NET_TIMEOUTS.documentsJob),
    });
  } catch (err) {
    release();
    throw mapNetworkError(route, err);
  }
  try {
    return await readAnswer(route, res);
  } catch (err) {
    // The deadline can fire while the answer body is still being read.
    throw mapNetworkError(route, err);
  } finally {
    release();
  }
}

/** A failure of the request itself (never an engine status): the deadline
 *  as busy, anything else as unavailable. An error the engine answered
 *  (readAnswer's own) passes through. */
function mapNetworkError(route: Pick<RouteDef, 'key'>, err: unknown): Error {
  const e = err as Error;
  if (
    e instanceof DocumentsUnavailableError ||
    e instanceof DocumentsRenderError ||
    e instanceof DocumentsFormError ||
    e instanceof DocumentsTooLargeError ||
    e instanceof DocumentsBusyError
  ) {
    return e;
  }
  if (e.name === 'TimeoutError' || e.name === 'AbortError') {
    return new DocumentsBusyError(`${route.key} did not finish in time`);
  }
  return new DocumentsUnavailableError(`the engine did not answer (${e.message})`);
}

async function readAnswer(
  route: Pick<RouteDef, 'path' | 'key'>,
  res: Response,
): Promise<GotenbergAnswer> {
  if (res.ok) {
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: (res.headers.get('content-type') ?? 'application/octet-stream')
        .split(';')[0]!
        .trim(),
      filename: filenameOf(res.headers.get('content-disposition')),
    };
  }
  const text = errorText(await res.text().catch(() => ''));
  switch (res.status) {
    case 400:
      throw new DocumentsFormError(text);
    case 401:
      throw new DocumentsUnavailableError(
        'the engine refused the password (GOTENBERG_PASSWORD differs from the container)',
      );
    case 403:
      // The outbound filter: an address outside the allow list (the print
      // origin and the engine's own upload dir). Only a URL route can get
      // here, and only with an address the package did not build.
      throw new DocumentsRenderError(
        `the engine refused the address (${text}); it fetches nothing but this brain's own print pages`,
      );
    case 409:
      throw new DocumentsRenderError(text);
    case 413:
      throw new DocumentsTooLargeError(text);
    case 503:
      throw new DocumentsBusyError(text);
    default:
      throw new DocumentsUnavailableError(`the engine answered ${res.status} (${text})`);
  }
}
