import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import { createTable, getTable, saveTableDraft } from '@/lib/tables';
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

  // First sheet → this table's draft.
  const first = sheets[0]!;
  const draftDoc = tableDocFromGrid(first);
  const ok = await saveTableDraft(user.id, id, draftDoc);
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Extra sheets → sibling tables (committed).
  const extra: { id: string; title: string; sheet: string }[] = [];
  for (let i = 1; i < sheets.length; i++) {
    const sheet = sheets[i]!;
    const sib = await createTable(user.id, {
      title: (sheet.name || `Sheet ${i + 1}`).slice(0, 200),
      data: tableDocFromGrid(sheet) as never,
      tags: table.tags,
    });
    extra.push({ id: sib.id, title: sib.title, sheet: sheet.name });
  }

  return NextResponse.json({
    ok: true,
    sheets: sheets.length,
    columns: draftDoc.columns.length,
    rows: draftDoc.rows.length,
    extra_tables: extra,
  });
}
