import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { getTable, saveTableDraft } from '@/lib/tables';
import { parseSheetToGrid } from '@mantle/files/sheet-to-grid';
import { tableDocFromGrid } from '@mantle/content/table-model';

/**
 * Import a spreadsheet into this table. The FIRST sheet replaces the current
 * grid as a DRAFT (the user reviews + commits); any additional sheets are
 * created as sibling tables (committed) and their ids returned. Accepts a
 * multipart `file` (.xlsx / .xls / .csv).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;

  const table = await getTable(user.id, id);
  if (!table) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'no file uploaded' }, { status: 400 });
  }
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
    return NextResponse.json({ error: 'expected a .xlsx / .xls / .csv file' }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  let sheets;
  try {
    sheets = parseSheetToGrid(buf);
  } catch (err) {
    return NextResponse.json(
      { error: `parse failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 },
    );
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
  const ok = await saveTableDraft(user.id, id, { tabs });
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return NextResponse.json({
    ok: true,
    sheets: sheets.length,
    tabs: tabs.map((t) => ({ name: t.name, columns: t.columns.length, rows: t.rows.length })),
  });
}
