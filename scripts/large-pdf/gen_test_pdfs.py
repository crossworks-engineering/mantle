#!/usr/bin/env python3
"""Made-up PDFs for the large-PDF pipeline's tests (task 8d40932a). No client
data: every page and picture is drawn here.

  gen_test_pdfs.py scans OUT.pdf PAGES
      A scanned book: A4 at 200 dpi, gray, one JPEG a page, each a made-up
      piping spec with `PAGE <n>` at its top, a little skew and noise. The
      true text of each page goes to OUT.truth.jsonl. Written page by page,
      so memory stays flat (the brief's generator, page 4ff4d4e5 section 9).

  gen_test_pdfs.py pictures OUT.pdf PICTURES PAD_MB
      A text PDF with PICTURES distinct pictures, four a page (each 400 by
      300 px, numbered), a line of real text on every page, and PAD_MB of
      random bytes in an object no page uses, so the file is past the 256 MB
      pdfjs opens while its page windows stay small (qpdf keeps only the
      objects of the pages it copies).

  gen_test_pdfs.py finish DIR
      The large-PDF finish's set (finish(), below): 1 and 7 typed pages, 7
      scanned, a 108-page scanned book with figure pages, and a typed file
      of over 1,000,000 characters.

Run with Python 3 and Pillow, with the DejaVu fonts at
/usr/share/fonts/truetype/dejavu/.
"""
import io
import json
import os
import random
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
ITEMS = ['PIPE', 'ELBOW 90 LR', 'ELBOW 45 LR', 'TEE EQUAL', 'TEE RED', 'REDUCER CONC',
         'REDUCER ECC', 'CAP', 'FLANGE WN', 'FLANGE BLIND', 'GASKET SPW', 'STUD BOLT',
         'GATE VALVE', 'GLOBE VALVE', 'CHECK VALVE', 'BALL VALVE', 'NIPPLE', 'COUPLING']
MATS = ['ASTM A106 GR B', 'ASTM A234 WPB', 'ASTM A105', 'ASTM A193 B7', 'ASTM A194 2H',
        'ASTM A312 TP316L', 'ASTM A182 F316L', 'ASTM A403 WP316L', 'API 600', 'API 602']
ENDS = ['BE', 'SW', 'THD', 'RF', 'RTJ', 'PE']
SCHS = ['SCH 40', 'SCH 80', 'SCH 160', 'STD', 'XS', 'XXS', 'CL150', 'CL300', 'CL600']


class Writer:
    """A PDF written by hand, one object at a time."""

    def __init__(self, out):
        self.fh = open(out, 'wb')
        self.at = {}
        self.fh.write(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')

    def obj(self, n, body):
        self.at[n] = self.fh.tell()
        self.fh.write(f'{n} 0 obj\n'.encode() + body + b'\nendobj\n')

    def stream(self, n, head, data):
        self.obj(n, f'<< {head} /Length {len(data)} >>\nstream\n'.encode() + data + b'\nendstream')

    def close(self, count):
        xref = self.fh.tell()
        self.fh.write(f'xref\n0 {count}\n0000000000 65535 f \n'.encode())
        for k in range(1, count):
            self.fh.write(f'{self.at[k]:010d} 00000 n \n'.encode())
        self.fh.write(f'trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
        self.fh.close()


def scan_page(rng, page_no):
    w, h = 1654, 2339  # A4 at 200 dpi
    im = Image.new('L', (w, h), 255)
    d = ImageDraw.Draw(im)
    f = ImageFont.truetype(FONT, 24)
    fb = ImageFont.truetype(BOLD, 34)
    spec = f'{rng.choice("ABCDE")}{rng.randint(1, 9)}{rng.choice(["", "C", "S"])}{rng.randint(1, 9)}'
    title = f'PIPING MATERIAL SPECIFICATION {spec}  REV {rng.randint(0, 5)}'
    head = f'SP-00-00 MADE-UP SPEC BOOK  PAGE {page_no}'
    d.text((90, 90), head, font=fb, fill=0)
    d.text((90, 150), title, font=fb, fill=0)
    cols = [90, 400, 560, 720, 1130, 1260, 1560]
    y = 290
    rows = []
    for _ in range(42):
        lo = rng.choice(['1/2', '3/4', '1', '2', '3', '4', '6', '8'])
        hi = rng.choice(['2', '4', '8', '12', '16', '24'])
        rows.append([rng.choice(ITEMS), f'{lo}-{hi}', rng.choice(SCHS), rng.choice(MATS),
                     rng.choice(ENDS), f'{rng.randint(100, 999)}-{rng.randint(10, 99)}'])
    for r in rows:
        for c, t in zip(cols, r):
            d.text((c + 8, y), t, font=f, fill=0)
        y += 44
        d.line((cols[0], y - 6, cols[-1], y - 6), fill=0, width=1)
    truth = '\n'.join([head, title] + ['  '.join(r) for r in rows])
    im = im.rotate(rng.uniform(-0.5, 0.5), resample=Image.BICUBIC, fillcolor=255)
    im = im.filter(ImageFilter.GaussianBlur(0.5))
    px = im.load()
    for _ in range(4000):
        px[rng.randrange(w), rng.randrange(h)] = rng.randrange(0, 160)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=85)
    return buf.getvalue(), truth, w, h


def scans(out, pages):
    rng = random.Random(f'large-pdf-{os.path.basename(out)}-{pages}')
    pdf = Writer(out)
    tr = open(out.rsplit('.', 1)[0] + '.truth.jsonl', 'w')
    kids = ' '.join(f'{3 + 3 * i} 0 R' for i in range(pages))
    pdf.obj(1, b'<< /Type /Catalog /Pages 2 0 R >>')
    pdf.obj(2, f'<< /Type /Pages /Count {pages} /Kids [{kids}] >>'.encode())
    for i in range(pages):
        jpg, truth, w, h = scan_page(rng, i + 1)
        tr.write(json.dumps({'page': i + 1, 'text': truth}) + '\n')
        p, img, cnt = 3 + 3 * i, 4 + 3 * i, 5 + 3 * i
        pdf.obj(p, (f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
                    f'/Resources << /XObject << /Im0 {img} 0 R >> >> /Contents {cnt} 0 R >>').encode())
        pdf.stream(img, f'/Type /XObject /Subtype /Image /Width {w} /Height {h} '
                        f'/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode', jpg)
        pdf.stream(cnt, '', b'q 595 0 0 842 0 0 cm /Im0 Do Q')
    pdf.close(3 + 3 * pages)
    tr.close()


def picture(n):
    rng = random.Random(f'picture-{n}')
    im = Image.new('RGB', (400, 300), (rng.randrange(256), rng.randrange(256), rng.randrange(256)))
    d = ImageDraw.Draw(im)
    for _ in range(12):
        x, y = rng.randrange(400), rng.randrange(300)
        d.rectangle((x, y, x + rng.randrange(20, 120), y + rng.randrange(20, 90)),
                    fill=(rng.randrange(256), rng.randrange(256), rng.randrange(256)))
    d.text((20, 20), f'FIGURE {n}', font=ImageFont.truetype(BOLD, 40), fill=(0, 0, 0))
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=80)
    return buf.getvalue()


def pictures(out, count, pad_mb):
    per = 4
    pages = (count + per - 1) // per
    pdf = Writer(out)
    # Objects: 1 catalog, 2 pages, 3 font, 4 padding; then per page: page,
    # content, and `per` pictures.
    stride = 2 + per
    first = 5
    kids = ' '.join(f'{first + stride * i} 0 R' for i in range(pages))
    pdf.obj(1, b'<< /Type /Catalog /Pages 2 0 R >>')
    pdf.obj(2, f'<< /Type /Pages /Count {pages} /Kids [{kids}] >>'.encode())
    pdf.obj(3, b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    # No page uses object 4: qpdf leaves it out of every window.
    rnd = random.Random('padding')
    pad = rnd.randbytes(1024 * 1024)
    pdf.at[4] = pdf.fh.tell()
    pdf.fh.write(f'4 0 obj\n<< /Length {pad_mb * len(pad)} >>\nstream\n'.encode())
    for _ in range(pad_mb):
        pdf.fh.write(pad)
    pdf.fh.write(b'\nendstream\nendobj\n')
    n = 0
    for i in range(pages):
        base = first + stride * i
        here = list(range(n + 1, min(count, n + per) + 1))
        n += len(here)
        xobjs = ' '.join(f'/Im{k} {base + 2 + k} 0 R' for k in range(len(here)))
        pdf.obj(base, (f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
                       f'/Resources << /Font << /F1 3 0 R >> /XObject << {xobjs} >> >> '
                       f'/Contents {base + 1} 0 R >>').encode())
        draw = [f'BT /F1 12 Tf 50 800 Td (Made-up figures, page {i + 1}) Tj ET']
        for k in range(len(here)):
            x, y = 50 + (k % 2) * 260, 430 - (k // 2) * 220
            draw.append(f'q 240 0 0 180 {x} {y} cm /Im{k} Do Q')
        pdf.stream(base + 1, '', '\n'.join(draw).encode())
        for k, num in enumerate(here):
            pdf.stream(base + 2 + k, '/Type /XObject /Subtype /Image /Width 400 /Height 300 '
                                     '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
                       picture(num))
        for k in range(len(here), per):
            pdf.obj(base + 2 + k, b'null')
    pdf.close(first + stride * pages)


def finish(out_dir):
    """The large-PDF finish's e2e set (packages/content/src/
    large-pdf-windows.e2e.test.ts), from the made-up book of the Reader's
    own tests (server/parser/cad/tests/book_pdfs.py: prose, three ruled
    tables, a whitespace table, a figure, a blank page):

      one.pdf        1 typed page
      typed7.pdf     7 typed pages with the tables
      scanned7.pdf   the same 7 pages scanned
      scanbook.pdf   the 9-page book scanned 12 times over (108 pages): its
                     figure pages are left to vision (G1 page pictures)
      longtext.pdf   460 typed pages of prose, over 1,000,000 characters
    """
    here = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, os.path.join(here, '..', '..', 'server', 'parser', 'cad', 'tests'))
    import book_pdfs  # noqa: E402 - the Reader's own made-up book

    os.makedirs(out_dir, exist_ok=True)
    pages, _, _ = book_pdfs.book()
    book_pdfs.write_pdf(os.path.join(out_dir, 'one.pdf'), pages[:1], scan=set())
    book_pdfs.write_pdf(os.path.join(out_dir, 'typed7.pdf'), pages[:7], scan=set())
    book_pdfs.write_pdf(os.path.join(out_dir, 'scanned7.pdf'), pages[:7], scan=set(range(1, 8)))
    many = [p for _ in range(12) for p in pages]
    book_pdfs.write_pdf(os.path.join(out_dir, 'scanbook.pdf'), many, scan=set(range(1, len(many) + 1)))
    rng = random.Random('long-text')
    long_pages = []
    for p in range(1, 461):
        m = []
        book_pdfs.head(m, p)
        book_pdfs.prose(m, rng, 220, 34)
        long_pages.append(m)
    book_pdfs.write_pdf(os.path.join(out_dir, 'longtext.pdf'), long_pages, scan=set())


if __name__ == '__main__':
    if sys.argv[1] == 'scans':
        scans(sys.argv[2], int(sys.argv[3]))
    elif sys.argv[1] == 'pictures':
        pictures(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
    elif sys.argv[1] == 'finish':
        finish(sys.argv[2])
    else:
        sys.exit('usage: gen_test_pdfs.py scans OUT PAGES | pictures OUT PICTURES PAD_MB | finish DIR')
