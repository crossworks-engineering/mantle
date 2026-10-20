/**
 * Read text that code composes (a catalog query a module shares as a
 * string, a query sent on the simple protocol with its values inlined).
 * The raw write ban (eslint-rules/no-raw-write-sql.mjs) cannot read such
 * text, so it counts every `.unsafe(x)`, `sql.raw(x)` and `.execute(x)` of
 * it unless `x` is `readSql(...)` imported from @mantle/db: the check
 * moves here, to the moment the text runs.
 *
 * readSql answers the text itself, unchanged, when it is one statement
 * that only reads; it throws for a statement that writes (isWriteSql: a
 * leading write verb or DDL, a write clause anywhere, a row lock, a
 * sequence or advisory lock call) and for text with more than one
 * statement. Never a door for a write: a write is a typed drizzle write
 * or a definer call.
 */
import { isWriteSql } from './gateway/handles';

export class NotReadSqlError extends Error {
  constructor(why: string) {
    super(`readSql: ${why}; read text only (a write is a typed write or a definer call).`);
    this.name = 'NotReadSqlError';
  }
}

/** Whether `text` holds a `;` outside quotes, comments and dollar quotes
 *  with anything but blanks and comments after it. */
export function holdsMoreStatements(text: string): boolean {
  let i = 0;
  let ended = false;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (ended) return true;
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === c) {
          if (text[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const tag = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(text.slice(i));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        i = close < 0 ? n : close + tag[0].length;
        continue;
      }
    }
    if (c === ';') ended = true;
    i++;
  }
  return false;
}

export function readSql(text: string): string {
  if (isWriteSql(text)) throw new NotReadSqlError('the text writes');
  if (holdsMoreStatements(text))
    throw new NotReadSqlError('the text holds more than one statement');
  return text;
}
