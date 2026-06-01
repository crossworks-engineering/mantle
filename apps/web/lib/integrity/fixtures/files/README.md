# Integrity-probe sample files

Drop real sample files here. Each file-type fixture loads bytes from this
directory by an exact filename; a fixture whose file is missing reports
**MISSING** (not a failure), so the suite runs before these are in place.

| Filename | Fixture | What it should be | Expected outcome |
|---|---|---|---|
| `sample-text.pdf` | File · PDF (text) | A 1-page PDF **with a real text layer** (selectable text). Make the content meaningful + unique. | Indexed: summary + 768 embedding + tsv |
| `sample-scanned.pdf` | File · PDF (scanned) | An **image-only** PDF (no text layer) — a scan/photo exported to PDF. | Correct skip: `no_text_layer` (unless a vision worker is wired) |
| `sample.docx` | File · DOCX | A small Word doc with a few paragraphs of unique prose. | Indexed: summary + 768 embedding + tsv |
| `sample-image.png` | File · image | A small PNG. | Skips `no_text_layer` until the vision worker is wired |

Notes:
- Keep them small (a few KB–tens of KB) — they're checked into the repo.
- Make the text **distinctive** (invented names/terms) so probe entities don't
  merge into the real graph; cleanup also sweeps them by name.
- The plain-text file fixture (`File · text`) needs nothing here — it's
  generated inline by the harness.

To add more types later (xlsx, pptx, csv, html, md, rtf, …): drop the sample
here and add a one-line fixture + spec row in `../../fixtures.ts` / `../../spec.ts`.
