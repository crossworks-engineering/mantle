/**
 * Print an access oracle's answers, or the inputs whose answer changed
 * (oracle-answers.ts):
 *
 *   pnpm -C packages/db -s oracle:answers a8 > /tmp/a8-before.txt   # on main
 *   pnpm -C packages/db -s oracle:answers a8 --against /tmp/a8-before.txt
 *
 * With no name: each oracle's input count and hash, as the test pins them.
 */
import { readFileSync } from 'node:fs';
import {
  ORACLES,
  oracleAnswerDiff,
  oracleAnswerHash,
  oracleAnswerLines,
  type OracleName,
} from './oracle-answers';

const [name, flag, file] = process.argv.slice(2);
if (!name) {
  for (const o of ORACLES) {
    const h = oracleAnswerHash(o);
    console.log(`${o}\t${h.inputs}\t${h.sha256}`);
  }
} else if (!(ORACLES as readonly string[]).includes(name)) {
  console.error(`oracle:answers: one of ${ORACLES.join(', ')}`);
  process.exitCode = 2;
} else if (flag === '--against' && file) {
  const diff = oracleAnswerDiff(
    readFileSync(file, 'utf8').split('\n'),
    oracleAnswerLines(name as OracleName),
  );
  for (const l of diff) console.log(l);
  console.error(`oracle:answers ${name}: ${diff.length} lines differ`);
  if (diff.length) process.exitCode = 1;
} else if (flag) {
  console.error('oracle:answers <name> [--against <file of its lines>]');
  process.exitCode = 2;
} else {
  for (const l of oracleAnswerLines(name as OracleName)) console.log(l);
}
