/**
 * The A8 cells that fail today (the database, or a way in, gives another
 * answer than the guide), each a finding for the owner to decide: the cell's
 * name (a8-grid.ts cellName, or a surface cell's name) and what the oracle
 * expects against what the system does. A8 is test code only: a finding is
 * never fixed here. The grid fails on a failure not listed, and on a listed
 * one that passes (the list only shrinks). docs/actors.md, "A8 matrix".
 */
export const KNOWN_FAILURES: Readonly<Record<string, string>> = {};
