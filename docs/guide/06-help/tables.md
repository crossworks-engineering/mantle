---
title: Tables
toolGroups: [tables-read, tables-rows, tables, tables-import]
---

## Tables

Tables are typed data grids for anything that belongs in rows and columns: an
asset register, expenses, readings, a parts list.

- Each column has a type (text, number, currency, percent, date, checkbox,
  select, URL, formula, reference and more), so the grid can total a column,
  sort dates properly and refuse a word where a number belongs.
- A table can have several **tabs**, like sheets in a spreadsheet. A reference
  column links to a row in another tab.
- Start with **New table** (the plus button). **Import a spreadsheet** loads
  an xlsx, xls or csv file into the table, one tab per sheet.
- Tables live in folders. Drag them into the order you want; everyone sees
  the same order.
- Edits are saved as a draft. Press **Commit** to publish them, or **Discard
  the draft** to drop them.

## Assistant

- "How much did I spend on diesel last quarter?"
- "Add a row to the maintenance table: pump 3, serviced today."
- "Which assets have no service date?"
- "Turn the spreadsheet I just sent into a table."

The assistant answers from the data itself, so a question with an exact answer
gets one. It can add or change one row or many in one go ("mark these five
done"). Rows it adds land in the draft, like yours: check them, then commit.

## Technical

Each table is its own SQLite file under `TABLE_DB_DIR`, with a separate
`.draft.sqlite` file while edits are uncommitted. Each tab is a SQL view named
after its columns. The table is also an ordinary item in the brain, with a
summary, so it turns up in search.

The assistant reads with `table_schema` (every tab's columns, types and row
counts) and `table_sql` (a read-only SELECT, which can join tabs in one
table). It adds and changes rows with `table_row_add` and `table_row_update`,
or many at once with `table_rows_add` and `table_rows_upsert`, and imports
with `table_from_file`. `table_rows_upsert` with the key `["@row_id"]` changes
many rows by their row id, for a table with no unique column. Each row
carries its row id and is only updated, never added. An unknown, missing or
repeated id, or a row with no cells, refuses the whole call before anything
is written. For an MCP client that asks you to allow every write, ten row
edits are then one approval, not ten. Building grids (columns, tabs, imports
that need logic) is the Ledger specialist's job. Deleting a table needs a
tool group that no agent has by default.

`table_sql` runs each statement in a separate process that is stopped at its
time limit. That process has a memory limit (1 GB on Linux), and a value or a
reply may hold at most 16 MB. A statement past a limit is refused with a hint: add a
`LIMIT`, select fewer columns or aggregate in SQL.
