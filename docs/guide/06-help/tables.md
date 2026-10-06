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
- Start with **New table** (the plus button). **Import** loads a spreadsheet
  file into a table.
- Edits are saved as a draft. Press **Commit** to publish them, or **Discard**
  to drop them.

## Assistant

- "How much did I spend on diesel last quarter?"
- "Add a row to the maintenance table: pump 3, serviced today."
- "Which assets have no service date?"
- "Turn the spreadsheet I just sent into a table."

The assistant answers from the data itself, so a question with an exact answer
gets one. Rows it adds land in the draft, like yours: check them, then commit.

## Technical

Each table is its own SQLite file under `TABLE_DB_DIR`, with a separate
`.draft.sqlite` file while edits are uncommitted. Each tab is a SQL view named
after its columns. The table is also an ordinary item in the brain, with a
summary, so it turns up in search.

The assistant reads with `table_schema` (every tab's columns, types and row
counts) and `table_sql` (a read-only SELECT, which can join tabs in one
table). It adds and changes rows with `table_row_add` and `table_row_update`,
and imports with `table_from_file`. Building grids is the Ledger specialist's
job. Deleting a table needs the Table admin group, which no agent has by
default.
