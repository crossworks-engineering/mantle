/**
 * The shipped Recall maps (MANIFEST_RECALL_MAPS), with no database:
 *  - the file-database prompt names every file type that gets a file
 *    database (dbExtsOf over the built-in Readers), so a Reader added later
 *    fails here until the prompt names its type;
 *  - the words fit Recall's limits, and hold no em dash;
 *  - with an embedder (RECALL_MATCH_EMBED_URL, an OpenAI-shaped
 *    /v1/embeddings of EmbeddingGemma, the default local embedder), plain
 *    task lines match the prompt over the floor of recall_match, and
 *    unrelated lines do not. Skipped with no embedder (CI):
 *
 *   RECALL_MATCH_EMBED_URL=http://127.0.0.1:56434/v1 pnpm test server/web/lib/system-manifest/recall-maps.test.ts
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_PIPELINES, dbExtsOf } from '@mantle/files';
import { MANIFEST_RECALL_MAPS } from './manifest';

const FILE_DBS = MANIFEST_RECALL_MAPS.find((m) => m.key === 'file-databases')!;

/** recall_match's floor (packages/tools/src/builtins-recall.ts MATCH_FLOOR). */
const MATCH_FLOOR = 0.35;

describe('the shipped Recall maps', () => {
  it('the file-database prompt names every file type with a file database', () => {
    const exts = [...dbExtsOf(BUILTIN_PIPELINES)];
    expect(exts.length).toBeGreaterThan(5);
    const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const useWhen = words(FILE_DBS.prompt.useWhen);
    const body = words(FILE_DBS.prompt.bodyMd);
    for (const ext of exts) {
      expect(useWhen.has(ext), `use_when names .${ext}`).toBe(true);
      expect(body.has(ext), `the body names .${ext}`).toBe(true);
    }
  });

  it('fit the limits of a Recall write, with unique keys and no em dash', () => {
    expect(new Set(MANIFEST_RECALL_MAPS.map((m) => m.key)).size).toBe(MANIFEST_RECALL_MAPS.length);
    for (const m of MANIFEST_RECALL_MAPS) {
      expect(m.title.length).toBeLessThanOrEqual(200);
      expect(m.prompt.title.length).toBeLessThanOrEqual(200);
      expect(m.enterWhen.length).toBeLessThanOrEqual(500);
      expect(m.prompt.useWhen.length).toBeLessThanOrEqual(500);
      expect(m.prompt.bodyMd.length).toBeLessThanOrEqual(6000);
      const all = [m.title, m.enterWhen, m.entryBody, ...Object.values(m.prompt)].join('\n');
      expect(all).not.toMatch(/[–—]/);
    }
  });
});

const EMBED_URL = process.env.RECALL_MATCH_EMBED_URL;

describe.skipIf(!EMBED_URL)('recall_match finds the file-database prompt', () => {
  const MATCH = [
    'build an app that lists the tags on our P&IDs',
    'extract equipment from these drawings',
    'read the line numbers from the isometrics',
    'make a tool that reads our Excel registers',
    'build an app from our equipment register spreadsheet',
    'read the blocks in these DWGs',
  ];
  const NO_MATCH = [
    'write a poem about the sea',
    'summarize my emails from today',
    'schedule a meeting with the team on Friday',
    'translate this paragraph into French',
  ];

  it('over the floor for the task lines, under it for unrelated ones', async () => {
    const p = FILE_DBS.prompt;
    // The text a prompt is embedded from (packages/content/src/recall.ts).
    const card = `${p.title}\n${p.useWhen}\n${p.bodyMd}`.slice(0, 6000);
    const res = await fetch(`${EMBED_URL}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'embeddinggemma:latest',
        input: [card, ...MATCH, ...NO_MATCH],
      }),
    });
    const vecs = ((await res.json()) as { data: { embedding: number[] }[] }).data.map(
      (d) => d.embedding,
    );
    const cos = (a: number[], b: number[]) => {
      let ab = 0;
      let aa = 0;
      let bb = 0;
      a.forEach((x, i) => {
        ab += x * b[i]!;
        aa += x * x;
        bb += b[i]! * b[i]!;
      });
      return ab / Math.sqrt(aa * bb);
    };
    const score = (i: number) => cos(vecs[0]!, vecs[i + 1]!);
    MATCH.forEach((line, i) => expect(score(i), line).toBeGreaterThanOrEqual(MATCH_FLOOR + 0.03));
    NO_MATCH.forEach((line, i) => expect(score(MATCH.length + i), line).toBeLessThan(MATCH_FLOOR));
  }, 60_000);
});
