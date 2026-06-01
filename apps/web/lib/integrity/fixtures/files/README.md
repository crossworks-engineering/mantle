# Integrity-probe sample files

Real sample files for the file-type fixtures. Each file-type fixture loads
bytes from this directory by an exact filename; a fixture whose file is missing
reports **MISSING** (not a failure), so the suite still runs if one is removed.

Expectations follow the extractor's parser routing
(`packages/files/src/slug.ts` + `parse.ts`):

| Filename | Route | Expected outcome |
|---|---|---|
| `sample-text.pdf` | pdf-parse | Indexed (summary + 768 emb + tsv) |
| `sample.docx` | mammoth | Indexed |
| `sample.xlsx` | sheetjs | Indexed |
| `sample.csv` | utf8 | Indexed |
| `sample.json` | utf8 | Indexed |
| `sample.md` | utf8 | Indexed |
| `sample-scanned.pdf` | pdf-parse → no text | Skip `no_text_layer` (or vision-OCR if wired) |
| `sample.pptx` | **Tika** | Indexed *if Tika up*, else skip |
| `sample.odt` | **Tika** | Indexed *if Tika up*, else skip |
| `sample.epub` | **Tika** | Indexed *if Tika up*, else skip |
| `sample.rtf` | **Tika** | Indexed *if Tika up*, else skip |
| `sample-image.png` | **vision** | Indexed *if vision wired*, else skip |
| `sample-photo.jpg` | **vision** | Indexed *if vision wired*, else skip |
| `sample.svg` | none | Skip (no parser) |
| `sample.xml` | none | Skip (xml is **not** a text ext) |
| `sample-audio.mp3` | none | Skip (no file-drop STT — voice→STT is the Telegram path) |

The plain-text `File · text` row needs no file here — it's generated inline.

Notes:
- Keep samples small (the heavy 1 MB+ variants were dropped on purpose).
- Make the text **distinctive** (invented names/terms) so probe entities don't
  merge into the real graph; cleanup also sweeps them by name.
- To add a type: drop the sample, add a `fileFixture('sample.<ext>')` builder in
  `../../fixtures.ts` and a spec row in `../../spec.ts`.
