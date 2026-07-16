/**
 * Standalone probe runner — exercised against the PROD IMAGE in the release
 * workflow (docker run … tsx packages/tabledb/src/probes-cli.ts) so drift in
 * the shipped Node binary is caught before a release is cut, not on a box.
 *
 *   pnpm exec tsx packages/tabledb/src/probes-cli.ts
 *
 * Exit 0 when every required probe passes; 1 otherwise.
 */
import { runTableStorageProbes } from './probes';

const report = await runTableStorageProbes();
for (const r of report.results) {
  const mark = r.ok ? 'ok  ' : r.required ? 'FAIL' : 'info';
  console.log(`[${mark}] ${r.key} — ${r.detail}`);
}
if (!report.ok) {
  console.error(
    'table-storage probes FAILED — node:sqlite behavior drifted; do not ship table storage on this image',
  );
  process.exitCode = 1;
} else {
  console.log(`table-storage probes passed (node ${process.version})`);
}
