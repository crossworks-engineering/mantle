/**
 * The step of the Q-Note template (docs/pipelines.md, "Text and pictures
 * from every Reader"): a made-up field note format, `.qnote`, that the box
 * has no reader for. It gives the file's text for search and no tabs, so
 * the file gets no database, and the core makes its summary and its
 * passages from this text as for any document. A file that is not a
 * Q-Note is `not_mine`. No types are imported, so the folder is a whole
 * package as it is.
 */
type Job = { bytes(): Promise<Buffer> };

export const step = async (_req: unknown, job: Job) => {
  const text = (await job.bytes()).toString('utf8');
  if (!text.startsWith('QNOTE ')) return { status: 'not_mine' as const };
  const at = text.indexOf('\n---\n');
  const head = at < 0 ? '' : text.slice(0, at);
  const body = at < 0 ? text : text.slice(at + 5);
  const field = (name: string) =>
    head
      .split('\n')
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2)
      .trim() ?? '';
  const title = field('TITLE') || 'Untitled note';
  const lines = [
    `${title}.`,
    field('DATE') && `Date: ${field('DATE')}.`,
    field('BY') && `By: ${field('BY')}.`,
  ];
  return {
    status: 'ok' as const,
    calls: [
      {
        call: 'tool' as const,
        tool: 'file_tabs_write',
        input: { tabs: [], text: `${lines.filter(Boolean).join(' ')}\n\n${body.trim()}` },
      },
    ],
  };
};
