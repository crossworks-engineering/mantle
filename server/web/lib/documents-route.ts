import { z } from 'zod';
import { NextResponse } from '@/server/http-compat';
import { runDocuments, type DocumentsResult } from '@mantle/documents';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import type { Login } from '@/lib/auth/login';
import { readBody } from '@/lib/read-body';

/**
 * The HTTP surface of the documents engine (docs/documents.md): POST
 * /api/v1/documents/<family>/<route>, the paths mirroring Gotenberg's
 * (`/forms/` dropped). One body for every route:
 *
 *   { inputs: {...}, options: {...}, filename?: "stem" }
 *
 * inputs are Mantle refs (file_ids, node_id, html, markdown, ...; the
 * package's DocumentsInputs); options are the engine's own field names,
 * checked by the route's schema, the Mantle-owned fields refused. The answer
 * is the file node the output landed in (the saveExport rules), or, with
 * `?return=bytes`, the bytes themselves with a safe download name; the two
 * JSON routes answer `{ result }`. Session or API key (any login, keyArea
 * files); the rate limit is the row's (`documents`). Errors are the
 * package's domain errors: 400 (an input or option), 409 (the engine could
 * not render), 413 (too large), 503 (the service is off, busy or not
 * answering).
 */
const Body = z
  .object({
    inputs: z.record(z.string(), z.unknown()).optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    filename: z.string().max(200).optional(),
  })
  .strict();

export async function handleDocumentsPost(
  req: Request,
  login: Login,
  route: string,
): Promise<Response> {
  const body = await readBody(req, Body);
  const wantBytes = new URL(req.url).searchParams.get('return') === 'bytes';
  const result: DocumentsResult = await runDocuments(
    { route, inputs: body.inputs, options: body.options, filename: body.filename },
    { ownerId: login.brainId, actorLoginId: login.loginId },
    wantBytes ? 'bytes' : 'file',
  );
  if (result.kind === 'json')
    return NextResponse.json({ route: result.route, result: result.json });
  if (result.kind === 'bytes') {
    const bytes = new Uint8Array(result.bytes);
    return new Response(bytes, {
      status: 200,
      headers: {
        ...safeDownloadHeaders(result.contentType, result.filename),
        'content-length': String(bytes.byteLength),
      },
    });
  }
  return NextResponse.json({ route: result.route, file: result.file }, { status: 201 });
}
