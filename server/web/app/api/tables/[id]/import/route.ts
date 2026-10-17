import { NextResponse } from '@/server/http-compat';
import { assertItemRight } from '@mantle/db';
import { ownerCaller } from '@/lib/auth';
import { getTable, saveTableDraft } from '@/lib/tables';
import { parseSpreadsheetToGrid } from '@mantle/files/sheet-to-grid';
import { tableDocFromGrid } from '@mantle/content-core/table-model';
import { errorMessage } from '@mantle/std';
import type { RouteParams } from '@/lib/route-params';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

/**
 * Import a spreadsheet into this table (v2.1 P2): the workbook replaces the
 * current DRAFT whole — every sheet becomes a tab, and the user reviews +
 * commits once. Accepts a multipart `file` (.xlsx / .xls / .csv).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;

  const table = await getTable(user.id, id);
  if (!table) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // The import replaces the draft: the caller's edit first (pre-check
  // removal part 2), after the scoped read above (a table it does not read
  // is the 404 of none), before the upload is read or parsed.
  await assertItemRight(id, 'edit');

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'no file uploaded' }, { status: 400 });
  }
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
    return NextResponse.json({ error: 'expected a .xlsx / .xls / .csv file' }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
  let sheets;
  try {
    sheets = await parseSpreadsheetToGrid(buf, ext);
  } catch (err) {
    return NextResponse.json({ error: `parse failed: ${errorMessage(err)}` }, { status: 400 });
  }
  if (sheets.length === 0) {
    return NextResponse.json({ error: 'no tabular data found' }, { status: 400 });
  }

  // One workbook per spreadsheet (v2.1 P2): every sheet becomes a TAB of this
  // table's draft — the user reviews the whole workbook and commits once. No
  // more sibling-table splitting.
  const tabs = sheets.map((sheet, i) => ({
    ...tableDocFromGrid(sheet),
    name: (sheet.name || `Sheet${i + 1}`).slice(0, 100),
  }));
  // `replace`: a parsed-file workbook is a deliberate whole-table
  // replacement — the clipped-grid truncation guard doesn't apply and the
  // ceiling is the import cap, not the 10k grid window (audit: re-importing
  // into a >10k table 500'd with windowed-read advice).
  // Over the import cap (TableTooLargeError) answers 400, an app table 409,
  // by the one table (A10 part 2); a fault the opaque 500.
  const result = await saveTableDraft(user.id, id, { tabs }, { replace: true });
  if (!result) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return NextResponse.json({
    ok: true,
    sheets: sheets.length,
    tabs: tabs.map((t) => ({ name: t.name, columns: t.columns.length, rows: t.rows.length })),
  });
}
