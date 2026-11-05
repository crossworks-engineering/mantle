import { envNum } from '@mantle/config';
import { NextResponse } from '@/server/http-compat';
import { noneWordOf, tabsOfSheets } from '@mantle/content/file-database';
import { parseSpreadsheetToGrid } from '@mantle/files/sheet-to-grid';
import { recordIngest } from '@mantle/tracing';
import { ownerCaller } from '@/lib/auth';
import { BUFFERED_UPLOAD_BYTES, bodyTooLargeResponse } from '@/lib/body-limit';
import { createTable, getTable } from '@/lib/tables';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    creates: true,
    item: { none: 'creates an item: ?ws= names where it lands' },
    limits: { rateLimit: ['tablesImport'] },
  },
});

const SPREADSHEET = /\.(xlsx|xls|csv)$/i;

/**
 * The Tables screen's Import: a spreadsheet becomes a new committed Table, with
 * every sheet with rows as a tab, where New table would put it (`?ws=`). Whoever
 * may press New table may use it, as they could type those rows. No file lands
 * in Files: the bytes are only read here. A multipart `file` (.xlsx / .xls /
 * .csv), buffered under the body ceiling (MULTIPART_CEILINGS). A CSV is parsed in
 * this process, synchronously, so it keeps the file database's cap; a workbook
 * goes to the parser. Answers as POST /api/tables does: 201 `{ table }`.
 */
export async function POST(req: Request) {
  const user = ownerCaller();
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'no file uploaded' }, { status: 400 });
  }
  if (!SPREADSHEET.test(file.name)) {
    return NextResponse.json({ error: 'expected a .xlsx / .xls / .csv file' }, { status: 400 });
  }
  // The ceiling leaves room for the framing: the file alone keeps the cap.
  if (file.size > BUFFERED_UPLOAD_BYTES) return bodyTooLargeResponse(BUFFERED_UPLOAD_BYTES);
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  const csvCap = envNum('MANTLE_FILE_DB_CSV_MAX_MB') * 1024 * 1024;
  if (ext === 'csv' && file.size > csvCap) return bodyTooLargeResponse(csvCap);

  const bytes = Buffer.from(await file.arrayBuffer());
  let sheets;
  try {
    sheets = await parseSpreadsheetToGrid(bytes, ext);
  } catch (err) {
    const word = noneWordOf(err);
    // Not a word on the file (the reader was busy, say).
    if (!word) throw err;
    return NextResponse.json(
      {
        error:
          word === 'too-large'
            ? 'This workbook is too large to read. Save it as CSV and import that.'
            : 'This file could not be read as a spreadsheet.',
      },
      { status: 400 },
    );
  }
  const tabs = tabsOfSheets(sheets);
  if (tabs.length === 0) {
    return NextResponse.json({ error: 'no tabular data found' }, { status: 400 });
  }

  // Over the import cap (TableTooLargeError) answers 400, by the one table.
  const made = await createTable(user.id, {
    title: file.name.replace(SPREADSHEET, '').trim().slice(0, 200) || 'Imported table',
    tabs,
  });
  void recordIngest({
    source: 'table_create',
    ownerId: user.id,
    nodeId: made.id,
    summary: `Table imported (${tabs.length} tab${tabs.length === 1 ? '' : 's'}): ${made.title.slice(0, 80)}`,
    payload: { via: 'tables_import_route', tabs: tabs.length },
  });
  // As the table's own read gives it: the first tab's rows are windowed, where
  // the create's own answer holds them all.
  return NextResponse.json({ table: (await getTable(user.id, made.id)) ?? made }, { status: 201 });
}
