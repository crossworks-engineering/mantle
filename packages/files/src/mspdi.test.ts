/**
 * The fixture below is SYNTHESISED, not a trimmed real export, and must stay
 * that way. A genuine Project plan carries client identity in almost every
 * field — the plan name, custom-field values, charge codes, resource roles and
 * hourly rates — and this repo is public.
 *
 * It is built to reproduce the traps a real 1094-task export actually contained
 * (each one noted at the element that carries it), so the tests fail for the
 * same reasons production would.
 */
import { describe, expect, it } from 'vitest';
import {
  durationToHours,
  parseMspdi,
  parseMspdiToGrids,
  renderMspdiText,
  sniffMspdi,
} from './mspdi';
import { parseDocumentBytes } from './parse';

const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>plan.xml</Name>
  <Title>Turnaround</Title>
  <MinutesPerDay>480</MinutesPerDay>
  <ExtendedAttributes>
    <ExtendedAttribute><FieldID>188743731</FieldID><FieldName>Text1</FieldName><Alias>Area</Alias></ExtendedAttribute>
    <ExtendedAttribute><FieldID>188743734</FieldID><FieldName>Text2</FieldName></ExtendedAttribute>
    <ExtendedAttribute><FieldID>188776463</FieldID><FieldName>Task Status</FieldName></ExtendedAttribute>
    <ExtendedAttribute><FieldID>190873607</FieldID><FieldName>Portfolio</FieldName></ExtendedAttribute>
  </ExtendedAttributes>
  <Tasks>
    <Task>
      <UID>1</UID><ID>1</ID><Name>Whole job</Name><WBS>1</WBS><OutlineLevel>1</OutlineLevel>
      <IsNull>0</IsNull><Active>1</Active><Summary>1</Summary><Milestone>0</Milestone><Critical>1</Critical>
      <Start>2026-01-05T08:00:00</Start><Finish>2026-01-16T17:00:00</Finish>
      <Duration>PT80H0M0S</Duration><Work>PT120H0M0S</Work>
      <TotalSlack>0</TotalSlack><FreeSlack>0</FreeSlack>
      <b408001>17</b408001><b40800f>3</b40800f>
      <TimephasedData><Type>9</Type><Value>PT2H0M0S</Value></TimephasedData>
      <TimephasedData><Type>9</Type><Value>PT4H0M0S</Value></TimephasedData>
    </Task>
    <Task>
      <UID>2</UID><ID>2</ID><Name>Scaffold</Name><WBS>1.1</WBS><OutlineLevel>2</OutlineLevel>
      <IsNull>0</IsNull><Active>1</Active><Summary>0</Summary><Milestone>0</Milestone><Critical>1</Critical>
      <Start>2026-01-05T08:00:00</Start><Finish>2026-01-09T17:00:00</Finish>
      <Duration>PT40H0M0S</Duration><Work>PT40H0M0S</Work>
      <TotalSlack>0</TotalSlack><FreeSlack>0</FreeSlack>
      <ExtendedAttribute><FieldID>188743731</FieldID><Value>North</Value></ExtendedAttribute>
      <EnterpriseExtendedAttribute><FieldIDInHex>b40800f</FieldIDInHex><FieldID>188776463</FieldID><Value>On Schedule</Value></EnterpriseExtendedAttribute>
      <Baseline><Number>0</Number><Start>2026-01-05T08:00:00</Start><Finish>2026-01-08T17:00:00</Finish><Work>PT32H0M0S</Work><Cost>4000</Cost></Baseline>
      <b408001>4</b408001>
    </Task>
    <Task>
      <UID>3</UID><ID>3</ID><Name>Inspect</Name><WBS>1.2</WBS><OutlineLevel>2</OutlineLevel>
      <IsNull>0</IsNull><Active>1</Active><Summary>0</Summary><Milestone>0</Milestone><Critical>0</Critical>
      <Start>2026-01-12T08:00:00</Start><Finish>2026-01-16T17:00:00</Finish>
      <Duration>PT40H0M0S</Duration><Work>PT80H0M0S</Work>
      <!-- fractional seconds: real roll-up output, and null under an integer-only pattern -->
      <ActualWork>PT17H11M37.17S</ActualWork>
      <!-- slack + lag are tenths of a minute, NOT ISO durations -->
      <TotalSlack>19200</TotalSlack><FreeSlack>9600</FreeSlack>
      <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><LinkLag>72000</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
      <ExtendedAttribute><FieldID>188743731</FieldID><Value>South</Value></ExtendedAttribute>
    </Task>
    <Task>
      <UID>4</UID><ID>4</ID><Name>Deleted placeholder</Name><WBS>1.3</WBS><OutlineLevel>2</OutlineLevel>
      <IsNull>1</IsNull><Active>1</Active><Summary>0</Summary>
    </Task>
  </Tasks>
  <Resources>
    <Resource><UID>0</UID><ID>0</ID><IsNull>0</IsNull><Type>1</Type></Resource>
    <Resource><UID>1</UID><ID>1</ID><Name>Rigger</Name><Initials>RG</Initials><IsNull>0</IsNull>
      <Type>1</Type><Group>Trades</Group><MaxUnits>2.00</MaxUnits><StandardRate>55.5</StandardRate>
      <Work>PT40H0M0S</Work><Cost>2220</Cost><IsGeneric>1</IsGeneric>
      <c408001>9</c408001>
      <TimephasedData><Type>1</Type><Value>PT8H0M0S</Value></TimephasedData>
    </Resource>
  </Resources>
  <Assignments>
    <Assignment><UID>1</UID><TaskUID>2</TaskUID><ResourceUID>1</ResourceUID><Units>1</Units>
      <Work>PT40H0M0S</Work><Cost>2220</Cost><Start>2026-01-05T08:00:00</Start><Finish>2026-01-09T17:00:00</Finish>
      <f408001>2</f408001>
      <TimephasedData><Type>1</Type><Value>PT8H0M0S</Value></TimephasedData>
    </Assignment>
    <Assignment><UID>2</UID><TaskUID>3</TaskUID><ResourceUID>-65535</ResourceUID><Units>1</Units>
      <Work>PT0H0M0S</Work><Cost>0</Cost></Assignment>
  </Assignments>
</Project>`;

const sheet = (name: string) => parseMspdiToGrids(XML).find((s) => s.name === name)!;
const cell = (name: string, row: number, col: string) => {
  const s = sheet(name);
  return s.rows[row]![s.columns.findIndex((c) => c.name === col)];
};
const colNames = (name: string) => sheet(name).columns.map((c) => c.name);

describe('durationToHours', () => {
  it('parses whole ISO-8601 durations', () => {
    expect(durationToHours('PT328H0M0S')).toBe(328);
    expect(durationToHours('PT3H20M0S')).toBe(3.33);
    expect(durationToHours('PT0H0M0S')).toBe(0);
  });

  it('parses FRACTIONAL seconds — Project emits these on roll-up rows', () => {
    expect(durationToHours('PT17517H11M37.17S')).toBe(17517.19);
  });

  it('returns null rather than guessing on junk', () => {
    expect(durationToHours('5 days')).toBeNull();
    expect(durationToHours('')).toBeNull();
    expect(durationToHours(undefined)).toBeNull();
  });
});

describe('sniffMspdi', () => {
  it('accepts a real MSPDI head', () => {
    expect(sniffMspdi(XML)).toBe(true);
  });

  it('accepts a namespace-less export that still has the Tasks shape', () => {
    expect(sniffMspdi('<?xml version="1.0"?><Project><Tasks><Task><UID>1</UID>')).toBe(true);
  });

  it('rejects a bare <Project> root — it is not unique to Microsoft', () => {
    expect(sniffMspdi('<?xml version="1.0"?><Project><groupId>x</groupId></Project>')).toBe(false);
  });

  it('rejects unrelated XML', () => {
    expect(sniffMspdi('<?xml version="1.0"?><catalog><book/></catalog>')).toBe(false);
  });
});

describe('parseMspdi — grids', () => {
  it('emits Tasks, Resources and Assignments', () => {
    expect(parseMspdiToGrids(XML).map((s) => s.name)).toEqual([
      'Tasks',
      'Resources',
      'Assignments',
    ]);
  });

  it('skips IsNull=1 placeholder rows', () => {
    expect(sheet('Tasks').rows).toHaveLength(3);
    expect(sheet('Tasks').rows.map((r) => r[4])).not.toContain('Deleted placeholder');
  });

  it('keeps rows in plan order, never sorted', () => {
    expect(sheet('Tasks').rows.map((r) => r[2])).toEqual(['1', '1.1', '1.2']);
  });

  it('flags summary rows so a total can exclude them', () => {
    expect(cell('Tasks', 0, 'Summary')).toBe(true);
    expect(cell('Tasks', 1, 'Summary')).toBe(false);
    // The roll-up equals its children exactly — which is why summing every row
    // would double-count.
    const s = sheet('Tasks');
    const w = s.columns.findIndex((c) => c.name === 'Work (hours)');
    const su = s.columns.findIndex((c) => c.name === 'Summary');
    const leaves = s.rows.filter((r) => r[su] !== true).reduce((a, r) => a + Number(r[w]), 0);
    expect(leaves).toBe(120);
    expect(s.rows.reduce((a, r) => a + Number(r[w]), 0)).toBe(240);
  });

  it('converts durations to hours and days off the plan calendar', () => {
    expect(cell('Tasks', 1, 'Duration (hours)')).toBe(40);
    expect(cell('Tasks', 1, 'Duration (days)')).toBe(5); // 480 min/day
    expect(cell('Tasks', 2, 'Actual Work (hours)')).toBe(17.19);
  });

  it('reads slack as tenths of a minute, not as a duration', () => {
    expect(cell('Tasks', 2, 'Total Slack (days)')).toBe(4); // 19200/10/480
    expect(cell('Tasks', 2, 'Free Slack (days)')).toBe(2);
    expect(cell('Tasks', 1, 'Total Slack (days)')).toBe(0);
  });

  it('resolves predecessors to names and keeps the UIDs beside them', () => {
    expect(cell('Tasks', 2, 'Predecessor UIDs')).toBe('2');
    expect(cell('Tasks', 2, 'Predecessors')).toBe('Scaffold (FS+15d)'); // 72000/10/480
  });

  it('flattens baseline 0', () => {
    expect(cell('Tasks', 1, 'Baseline Work (hours)')).toBe(32);
    expect(cell('Tasks', 1, 'Baseline Cost')).toBe(4000);
    expect(cell('Tasks', 2, 'Baseline Work (hours)')).toBeNull();
  });

  it('keeps naive local timestamps — no invented timezone', () => {
    expect(cell('Tasks', 1, 'Start')).toBe('2026-01-05T08:00:00');
  });
});

describe('parseMspdi — column selection', () => {
  it('emits a column only for custom fields a row actually uses', () => {
    const names = colNames('Tasks');
    expect(names).toContain('Area'); // aliased AND used
    expect(names).toContain('Task Status'); // enterprise, used
    expect(names).not.toContain('Portfolio'); // defined but never populated
  });

  it('drops unaliased Project placeholders like Text2', () => {
    expect(colNames('Tasks')).not.toContain('Text2');
  });

  it('never surfaces the undocumented hex-named internals', () => {
    for (const s of parseMspdiToGrids(XML)) {
      expect(s.columns.filter((c) => /^[a-f0-9]{7}$/.test(c.name))).toEqual([]);
    }
  });

  it('reads ExtendedAttribute and EnterpriseExtendedAttribute as separate paths', () => {
    expect(cell('Tasks', 1, 'Area')).toBe('North');
    expect(cell('Tasks', 1, 'Task Status')).toBe('On Schedule');
    expect(cell('Tasks', 2, 'Area')).toBe('South');
    expect(cell('Tasks', 2, 'Task Status')).toBeNull();
  });
});

describe('parseMspdi — resources and assignments', () => {
  it('drops the blank UID-0 placeholder resource', () => {
    expect(sheet('Resources').rows).toHaveLength(1);
    expect(cell('Resources', 0, 'Name')).toBe('Rigger');
  });

  it('humanises the resource type enum', () => {
    expect(cell('Resources', 0, 'Type')).toBe('Work');
  });

  it('resolves assignment UIDs to task and resource names', () => {
    expect(cell('Assignments', 0, 'Task')).toBe('Scaffold');
    expect(cell('Assignments', 0, 'Resource')).toBe('Rigger');
  });

  it('labels the -65535 sentinel instead of leaving a blank cell', () => {
    expect(cell('Assignments', 1, 'Resource')).toBe('(unassigned)');
  });
});

describe('parseMspdi — failure behaviour', () => {
  it('returns null on malformed XML so the caller can fall back to text', () => {
    expect(
      parseMspdi('<Project xmlns="http://schemas.microsoft.com/project"><Tasks><Task>'),
    ).toBeNull();
    expect(parseMspdiToGrids('not xml at all')).toEqual([]);
  });

  it('returns null on a well-formed document with no plan in it', () => {
    expect(
      parseMspdi(
        '<Project xmlns="http://schemas.microsoft.com/project"><Title>x</Title></Project>',
      ),
    ).toBeNull();
  });
});

describe('renderMspdiText', () => {
  it('renders task names and dates so search_chunks can reach them', () => {
    const t = renderMspdiText(XML);
    expect(t).toContain('Turnaround');
    expect(t).toContain('Scaffold');
    expect(t).toContain('2026-01-05');
  });

  it('states the roll-up caveat in prose, not only as a column', () => {
    // The Summary column only helps a reader who already knows to look. This
    // text is what gets summarised and chunked, so the warning travels with it.
    const t = renderMspdiText(XML);
    expect(t).toMatch(/summary \(roll-up\) rows/i);
    expect(t).toMatch(/Totals must exclude/i);
  });

  it('returns empty string rather than throwing on junk', () => {
    expect(renderMspdiText('nonsense')).toBe('');
  });
});

describe('parseDocumentBytes dispatch', () => {
  it('recognises a Project export by CONTENT and renders the plan', async () => {
    // Extension alone would send this through a generic text parser and lose
    // every task name. Returns before Tika is ever contacted.
    const text = await parseDocumentBytes(Buffer.from(XML, 'utf8'), 'xml');
    expect(text).toContain('Scaffold');
    expect(text).toContain('Project plan: Turnaround');
  });
});
