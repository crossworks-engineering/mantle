/**
 * The LX-9 format (made up for the template): a `#LX9 <n>` first line,
 * `#KEY=value` header lines, a `TIME;TAG;VALUE` head, then one reading a
 * line. Plain TypeScript, no import.
 */
export type Lx9 = {
  header: [string, string][];
  readings: [string, string, number | null, string][];
  tags: string[];
  site: string;
  unit: string;
  cut: boolean;
};

export function readLx9(text: string, maxRows: number): Lx9 {
  const header: [string, string][] = [];
  const readings: Lx9['readings'] = [];
  let cut = false;
  for (const raw of text.split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (line === '' || line === 'TIME;TAG;VALUE') continue;
    if (line.startsWith('#')) {
      const at = line.indexOf('=');
      if (at > 1) header.push([line.slice(1, at), line.slice(at + 1)]);
      continue;
    }
    if (readings.length >= maxRows) {
      cut = true;
      break;
    }
    const [time = '', tag = '', value = ''] = line.split(';');
    const n = Number(value);
    readings.push([time, tag, value !== '' && Number.isFinite(n) ? n : null, '']);
  }
  const unit = header.find(([k]) => k === 'UNIT')?.[1] ?? '';
  for (const r of readings) r[3] = unit;
  return {
    header,
    readings,
    tags: [...new Set(readings.map((r) => r[1]))],
    site: header.find(([k]) => k === 'SITE')?.[1] ?? '',
    unit,
    cut,
  };
}
