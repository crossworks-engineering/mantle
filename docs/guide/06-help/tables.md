---
title: Tables
toolGroups: [tables-read, tables-rows, tables, tables-import]
---

## Tables

Typed data grids, the place for anything that belongs in rows and columns
rather than prose: a register of assets, expenses, readings, contacts for a
project, a parts list.

Each column has a **type** (text, number, date, select, …), so the grid can add
up a column, sort a date properly, and refuse a word where a number belongs. A
table can hold several **tabs**, the way a spreadsheet holds sheets, and a
column in one tab can point at a row in another.

You can start a table from scratch, or drop in an `.xlsx` or `.csv` and have it
typed for you. Edits sit as a **draft** until you commit them, so a
half-finished import never becomes the version everyone reads.

## Assistant

Tables are one of the few things the assistant can both *read* and *write*, so
you can mostly just say what you want:

- "How much did I spend on diesel last quarter?"; it queries the grid and
  answers from the real numbers, rather than guessing from a summary.
- "Add a row to the maintenance table: pump 3, serviced today, R2 400."
- "Which assets have no service date recorded?"
- "Turn the spreadsheet I just sent into a table."

Two things worth knowing when you ask. It answers **from the data**, not from a
description of the data, so a question with a definite answer gets a definite
one. And row writes land in the draft like yours do: ask it to add something,
then look before you commit.

## Technical

Every table is its own **SQLite file** on disk (`TABLE_DB_DIR/<owner>/<node>.sqlite`,
plus a `.draft.sqlite` while there are uncommitted edits), not rows in a shared
Postgres table. That is what makes the grid genuinely queryable: each tab gets a
real SQL **view** named after its display columns, and published tabs also carry
an FTS5 trigram shadow index for text search.

The assistant reads a table through `table_sql`, which runs a **read-only
SELECT** against those views. It can join across tabs in the same workbook, but
not across separate tables, one file, one query. When it needs shape rather
than content it calls `table_schema`, which returns every tab's columns, types
and row counts in one go, so it can write a correct query without first pulling
the rows.

Alongside the file, the table is registered in the brain as an ordinary node
with a summary and embedding, which is how it turns up in search and how the
assistant knows the table exists before it ever queries it.

The capability is split deliberately across several tool groups: reading is
separate from row writes, which are separate from full grid authoring, which is
separate again from deleting a table. An agent granted the read group can answer
questions all day and cannot change a cell.
