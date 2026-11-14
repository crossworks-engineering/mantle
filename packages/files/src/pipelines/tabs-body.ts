/**
 * The body of an `after` pipeline's job: the tabs of the shape it names in
 * `match.after`, never the file. JSON Lines, UTF-8. One head line for each
 * tab, `{"tab":"Texts","columns":["Text","Page","Layer","X","Y"]}`, then one
 * line for each row: a JSON array in the order of the columns. The core
 * writes it (packages/content/src/pipeline-runner.ts, afterBodyOf); the job
 * reads it line by line for `job.tabRows` (server/parser/src/pipeline-job.ts).
 */

/** The head line of a tab, with its newline. */
export function tabHeadLine(tab: string, columns: readonly string[]): string {
  return `${JSON.stringify({ tab, columns })}\n`;
}

/** The line of one row, with its newline. */
export function tabRowLine(row: readonly unknown[]): string {
  return `${JSON.stringify(row)}\n`;
}

/** The rows of one tab, from the lines of a body. A line that is not JSON
 *  throws: the body is the core's own. */
export async function* tabRowsOf(
  lines: AsyncIterable<string>,
  tab: string,
): AsyncGenerator<unknown[]> {
  let inTab = false;
  for await (const line of lines) {
    if (line === '') continue;
    const value = JSON.parse(line) as unknown;
    if (Array.isArray(value)) {
      if (inTab) yield value;
      continue;
    }
    const head = value as { tab?: unknown };
    if (inTab) return;
    inTab = head.tab === tab;
  }
}
