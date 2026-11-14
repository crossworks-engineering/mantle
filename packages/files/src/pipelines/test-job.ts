/**
 * A job handle for a test that runs a step in its own process (the golden
 * compare of a move, docs/pipelines.md): the body, the folder and the rows
 * of an `after` body, as the parser job gives them. The native helpers are
 * the parser's alone: a step that needs one is tested through a real parser
 * job (packages/content/src/pipeline-runner.test.ts shows how).
 */
import type { StepJob } from './contract';
import { tabRowsOf } from './tabs-body';

async function* linesOf(text: string): AsyncGenerator<string> {
  for (const line of text.split('\n')) yield line;
}

export function inProcessStepJob(body: Buffer, dir: string): StepJob {
  const none = (name: string) => () => {
    throw new Error(`${name} runs only in a parser job`);
  };
  return {
    bytes: () => Promise.resolve(body),
    tabRows: (tab) => tabRowsOf(linesOf(body.toString('utf8')), tab),
    dir,
    deadline: Date.now() + 240_000,
    pdfEye: none('pdfEye'),
    pdfPictures: none('pdfPictures'),
    pdfPagePieces: none('pdfPagePieces'),
    cadRender: none('cadRender'),
    dwfRender: none('dwfRender'),
  };
}
