import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import type { PipelineTestResult } from '@mantle/client-types';
import { withViewer } from '@mantle/db';
import { ownerLoginCaller } from '@/lib/auth';
import { testPipeline } from '@/lib/pipelines';
import { readBody } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The settings area is the one check: only an Admin with it tests a
 *  pipeline. The handler asks nothing again. An area route runs on the
 *  system pool, so the test runs in the login's own scope (withViewer), as
 *  the tool runs in it: the file is read there, and a file the login cannot
 *  read is a 404 on both doors. A POST that only computes, as
 *  `pipeline_test` is a read: it writes nothing. */
export const policy = routePolicy({
  POST: {
    class: 'area',
    area: 'settings',
    effect: { read: 'tests a pipeline on one file in memory; writes nothing' },
  },
});

/** The file, and the options to try. The options are checked by
 *  checkOptions, the same check as `pipeline_test`. */
const TestBody = z.object({ fileId: z.string().max(64), options: z.unknown().optional() }).strict();

/**
 * POST /api/pipelines/:id/test: test one pipeline on one file
 * (docs/pipelines.md, "Test on one file"). The body is a
 * `PipelineTestBody`; the answer is a `PipelineTestResult`. Nothing is
 * written. An unknown pipeline or a file the caller cannot read is a 404; a
 * refused option is a 400 with its sentence. The MCP tool `pipeline_test`
 * does the same, through the same function.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const login = ownerLoginCaller();
  const { id } = await params;
  const body = await readBody(req, TestBody);
  const res = await withViewer({ login: login.loginId }, () =>
    testPipeline(login.brainId, id, body),
  );
  if (!res.ok) {
    if (res.missing === 'pipeline') {
      return NextResponse.json({ error: 'no pipeline has that id' }, { status: 404 });
    }
    if (res.missing === 'file') {
      return NextResponse.json({ error: 'no file has that id' }, { status: 404 });
    }
    return NextResponse.json({ error: res.error }, { status: 400 });
  }
  return NextResponse.json(res.result satisfies PipelineTestResult);
}
