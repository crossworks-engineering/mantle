# Tables

Keep rows of data in typed grids that you and the assistant can both read and change.

Use a table for anything that belongs in rows and columns: an asset register, expenses, meter readings, a parts list.

## Make a table

1. Open **Tables** and click **New table**.
2. Add columns with **+** at the end of the header row. Set each column's name and type (text, number, currency, date, select, formula and more) from its header menu.
3. Click **Add row** and type into the grid.
4. Click **Commit** to publish your edits and index the table.

Edits sit in a draft until you commit. **Discard** throws the draft away.

To start from a spreadsheet, click **Import** on a table and choose an `.xlsx` or `.csv` file. Each sheet becomes a tab. A spreadsheet uploaded to **Files** also becomes a table.

## Tabs, totals and formulas

- **Tabs**: a table can hold several tabs, like sheets in a workbook. Add one with **+** on the tab bar.
- **Totals**: pick a total (sum, average and so on) from a column's header menu. It shows in the footer.
- **Formulas**: a formula column works on the same row, with column names in braces. For example `{Qty} * {Price}` or `IF({Paid}, 0, {Due})`. Join text with `CONCAT`, not `+`.
- **Reference columns**: ask the assistant to link a column to a column in another tab. Its cells then offer that column's values as a dropdown.

## Ask the assistant

The assistant answers from the rows themselves, so a question with a definite answer gets a definite number.

- "How much did I spend on diesel last quarter?"
- "Which assets have no service date?"
- "Add a row to the maintenance table: pump 3, serviced today, 2 400."
- "Turn the spreadsheet I just sent into a table."

Its row changes land in the draft like yours. Check them, then commit.

## Share and download

- **Access** sets who can read the table. The levels are the same as for [pages](06-pages.md).
- **Download** exports Excel, a Markdown table or CSV.

## Next

- [Tasks and events](08-tasks-and-events.md)
- Screen help: [Tables](../06-help/tables.md), [Formulas](../06-help/formulas.md)
