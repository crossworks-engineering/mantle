import { describe, expect, it } from 'vitest';
import { readerFor, BUILTIN_PIPELINES, isAgent } from '@mantle/files';
import { BAD_LIMIT } from './dwg-reindex';
import { AGENT_REFUSED, readByOlder, runPipelineReread } from './pipeline-reread';
import { pipelinesOf as registryOf } from '@mantle/content/pipeline-registry';
/** The box's pipelines (the registry): the built-ins. */
const pipelines = registryOf([]);
const pipelinesOf = async () => pipelines;

describe('pipeline-reread: the stamp compare', () => {
  it('takes a missing stamp, another pipeline, or a lower version; leaves the rest', () => {
    const sheet = readerFor(BUILTIN_PIPELINES, 'csv')!;
    const stamp = (id: string, version: string) => ({
      pipeline_id: id,
      pipeline_version: version,
      pipeline_api: '1',
      shapes: '',
    });
    expect(readByOlder(null, sheet)).toBe(true);
    expect(readByOlder(stamp('plan-mspdi', sheet.version), sheet)).toBe(true);
    expect(readByOlder(stamp(sheet.id, '0.0.1'), sheet)).toBe(true);
    expect(readByOlder(stamp(sheet.id, sheet.version), sheet)).toBe(false);
    expect(readByOlder(stamp(sheet.id, '99.0.0'), sheet)).toBe(false);
  });
});

describe('pipeline-reread: the limit', () => {
  it('refuses --limit=0, a negative number and no number with exit code 2, before any read', async () => {
    for (const asked of ['0', '-1', 'all']) {
      const lines: string[] = [];
      const code = await runPipelineReread(
        ['--pipeline=sheet', `--limit=${asked}`, '--apply'],
        (l) => lines.push(l),
        pipelinesOf,
      );
      expect(code, asked).toBe(2);
      expect(lines, asked).toEqual([`[pipeline-reread] ${BAD_LIMIT}`]);
    }
  });
});

describe('pipeline-reread: a router is no id', () => {
  it('refuses --pipeline=pdf-router with exit code 2, in the dry run and with --apply, before any file', async () => {
    for (const argv of [['--pipeline=pdf-router'], ['--pipeline=pdf-router', '--apply']]) {
      const lines: string[] = [];
      const code = await runPipelineReread(argv, (l) => lines.push(l), pipelinesOf);
      expect(code, argv.join(' ')).toBe(2);
      // One line, the usage, and nothing planned: no file line, no count.
      expect(lines, argv.join(' ')).toHaveLength(1);
      expect(lines[0]).toMatch(
        /^\[pipeline-reread\] --pipeline=<id> is needed, one of: .* Nothing done\.$/,
      );
      expect(lines[0]).not.toContain('pdf-router');
      expect(lines[0]).toContain('drawing-pdf');
      expect(lines[0]).toContain('site-tags');
    }
  });
});

describe('pipeline-reread: an Agent is refused', () => {
  it('refuses an Agent with its one sentence and exit code 2, in the dry run and with --apply, before any file', async () => {
    const agent = BUILTIN_PIPELINES.find(isAgent)!;
    for (const argv of [[`--pipeline=${agent.id}`], [`--pipeline=${agent.id}`, '--apply']]) {
      const lines: string[] = [];
      const code = await runPipelineReread(argv, (l) => lines.push(l), pipelinesOf);
      expect(code, argv.join(' ')).toBe(2);
      // One line, the refusal, and nothing planned: no file line, no count.
      expect(lines, argv.join(' ')).toEqual([`[pipeline-reread] ${AGENT_REFUSED}`]);
    }
    expect(AGENT_REFUSED).toContain('pipeline_run');
    expect(AGENT_REFUSED).toContain('folder');
  });

  it('the usage names no Agent: its id is no id of this task', async () => {
    const agent = BUILTIN_PIPELINES.find(isAgent)!;
    const lines: string[] = [];
    await runPipelineReread(['--pipeline=nothing'], (l) => lines.push(l), pipelinesOf);
    expect(lines[0]).toContain('site-tags');
    expect(lines[0]).not.toContain(agent.id);
  });
});
