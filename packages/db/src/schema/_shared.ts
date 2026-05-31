import { customType } from 'drizzle-orm/pg-core';

/**
 * Custom types for Postgres extensions Drizzle doesn't ship out-of-the-box.
 * Both `ltree` and `vector` are stored as strings on the wire; we just need
 * Drizzle to emit the right column type in DDL.
 */

export const ltree = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'ltree';
  },
});

export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/** Dimension passed in at call site so we can use 768 for the local
 *  EmbeddingGemma default, or a different dim after a re-embed migration,
 *  without parallel column types. */
export const vector = (dim: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType() {
      return `vector(${dim})`;
    },
    toDriver(value: number[]) {
      return `[${value.join(',')}]`;
    },
    fromDriver(value: string) {
      return value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map(Number);
    },
  });
