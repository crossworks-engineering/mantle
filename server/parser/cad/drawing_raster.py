"""drawing_raster: the built-in Reader `drawing-raster` (docs/pipelines.md, "The raster
drawing reader"). Model-free.

Reads a scanned TIF drawing (1 bit), an Imagenation SMF raster (gzip or not;
one TIFF inside) or an HP-GL/2 plot (.000). It writes one tab, Drawing (Key,
Value): the format, the size, and the title the file names. It gives a short
text for search, and pictures of the sheet: the whole sheet and three crops
where a title block sits. It asks no model.

Anything else is `not_mine`, so it takes the path it took before this Reader:
a TIFF that is not 1 bit (a photo), a tiled TIFF, bytes of an SMF or a
`.000` that are not one. A raster past RASTER_MAX_PX fails, with a sentence.

The parser starts this file with the job's folder as its one argument
(pythonStep, server/parser/src/pipeline-job.ts): request.json and in.bin in,
result.json out. Libraries: the CAD tier's venv (numpy, OpenCV, ezdxf, and
Pillow with matplotlib) and the image's libtiff (Dockerfile: libtiff6).
Never ezdxf's to_pdf or to_pixmap: they need PyMuPDF (AGPL).
"""

import io
import json
import math
import os
import re
import sys
import zlib

import numpy as np
from PIL import Image

# A plot raster is 1.4 gigapixels. Pillow reads only its tags here; the pixels
# stay 1 bit (libtiff, below), so its bomb check would refuse an honest file.
# RASTER_MAX_PX is this Reader's own bound.
Image.MAX_IMAGE_PIXELS = None

MM_PER_IN = 25.4
PLU_MM = 0.025  # one HP-GL/2 plot unit
CROP_DPI = 200  # the crops, about this sharp
CROP_MAX_SIDE = 4000  # the longest side of a crop, px
# The core keeps no picture with a side under 200 px (MIN_IMAGE_DIMENSION in
# packages/files/src/embedded-images.ts), and says nothing: a smaller one is
# scaled up to it here, by MAX_UPSCALE at most: a sliver of a sheet that
# needs more gives no picture.
MIN_SIDE = 200
MAX_UPSCALE = 4
# 2.5 gigapixels: 312 MB packed, inside the parser's memory with the picture
# work. The largest plot seen is 1.36 gigapixels (336 MB peak in all).
RASTER_MAX_PX = 2_500_000_000
# The longest side a header may claim, in pixels (the largest plot seen:
# 44,480). The pixel cap alone does not hold the memory: a sheet one pixel
# wide packs to one byte a row.
RASTER_MAX_SIDE = 200_000
# The most pixels one band of a picture unpacks to one byte each.
BAND_MAX_PIXELS = 64_000_000
SMF_MAGIC = b"|>$$'"
SMF_MAX_BYTES = 64 * 1024 * 1024  # an SMF after gunzip, at most
SMF_TIFF_TRIES = 16  # the TIFF headers of an SMF tried, at most
TIFF_MAGICS = (b"II*\x00", b"MM\x00*")
# HP-GL/2: the PCL escape that enters it (ESC % n B), or a plot that starts
# with IN; or BP. PCL's own escape (ESC % -12345 X) is no match.
HPGL_ENTER = re.compile(rb"\x1b%-?\dB")
HPGL_START = re.compile(rb"\s*(IN\s*;|BP\s*[0-9\"])")
# Where a title block sits, as parts of the sheet (x0, y0, x1, y1).
CROPS = [
    ("Bottom band of the sheet, left half", (0.0, 0.86, 0.55, 1.0)),
    ("Bottom band of the sheet, right half", (0.45, 0.86, 1.0, 1.0)),
    ("Right side of the sheet (title block)", (0.80, 0.0, 1.0, 1.0)),
]


class NotMine(Exception):
    pass


class TooLarge(Exception):
    pass


# ── Rasters (TIF and SMF) ─────────────────────────────────────────────────


def libtiff():
    """libtiff by ctypes: the image's (libtiff6, the Dockerfile names it),
    else a copy in Pillow's wheel (a dev host). Pillow keeps a 1-bit image
    as one byte a pixel (1.4 GB for a plot); libtiff gives the packed bits
    (170 MB)."""
    import ctypes
    import ctypes.util
    import glob

    import PIL

    base = os.path.dirname(PIL.__file__)
    found = ["libtiff.so.6", ctypes.util.find_library("tiff")]
    found += glob.glob(os.path.join(base, ".dylibs", "libtiff*"))
    found += glob.glob(os.path.join(os.path.dirname(base), "pillow.libs", "libtiff*"))
    for name in found:
        if not name:
            continue
        try:
            lib = ctypes.CDLL(name)
        except OSError:
            continue
        lib.TIFFOpen.restype = ctypes.c_void_p
        lib.TIFFOpen.argtypes = [ctypes.c_char_p, ctypes.c_char_p]
        lib.TIFFClose.argtypes = [ctypes.c_void_p]
        lib.TIFFNumberOfStrips.restype = ctypes.c_uint32
        lib.TIFFNumberOfStrips.argtypes = [ctypes.c_void_p]
        lib.TIFFReadEncodedStrip.restype = ctypes.c_ssize_t
        lib.TIFFReadEncodedStrip.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_ssize_t]
        lib.TIFFSetWarningHandler.argtypes = [ctypes.c_void_p]
        lib.TIFFSetErrorHandler.argtypes = [ctypes.c_void_p]
        lib.TIFFSetWarningHandler(None)
        lib.TIFFSetErrorHandler(None)
        return lib
    raise RuntimeError("no libtiff in this image")


class Raster:
    """A 1-bit sheet, kept packed: `ink` holds 8 pixels a byte, bit 1 ink,
    the first pixel in the high bit. Page 1 of the TIFF file at `path`."""

    def __init__(self, path, im):
        tags = im.tag_v2
        bits = tags.get(258, 1)
        bits = bits[0] if isinstance(bits, tuple) and bits else bits
        if bits != 1 or tags.get(277, 1) != 1:
            raise NotMine("not a 1-bit raster")
        if 322 in tags:  # TileWidth: a tiled TIFF, read strip by strip only
            raise NotMine("a tiled TIFF")
        self.w, self.h = im.size
        if self.w < 1 or self.h < 1:
            raise NotMine("an empty raster")
        if max(self.w, self.h) > RASTER_MAX_SIDE or self.w * self.h > RASTER_MAX_PX:
            raise TooLarge(
                "The raster is %d x %d pixels, past the %.1f gigapixels or the %d pixels a side this Reader reads."
                % (self.w, self.h, RASTER_MAX_PX / 1e9, RASTER_MAX_SIDE)
            )
        self.dpi = dpi_of(im)
        rps = min(int(tags.get(278, self.h)), self.h)
        stride = (self.w + 7) // 8
        lib = libtiff()
        t = lib.TIFFOpen(path.encode(), b"r")
        if not t:
            raise RuntimeError("libtiff could not open the raster")
        try:
            buf = np.zeros(self.h * stride, np.uint8)
            for s in range(lib.TIFFNumberOfStrips(t)):
                at = s * rps * stride
                size = min(rps, self.h - s * rps) * stride
                if size <= 0:
                    break
                if lib.TIFFReadEncodedStrip(t, s, buf.ctypes.data + at, size) < 0:
                    raise RuntimeError("libtiff could not read strip %d" % s)
        finally:
            lib.TIFFClose(t)
        self.ink = buf.reshape(self.h, stride)
        if tags.get(262, 0) == 1:  # min-is-black: bit 1 is white
            np.invert(self.ink, out=self.ink)

    def size_mm(self):
        return (self.w / self.dpi * MM_PER_IN, self.h / self.dpi * MM_PER_IN)

    def picture(self, part, max_side, dpi_cap):
        """Gray picture of a part of the sheet: each output pixel is f x f
        pixels, darker by the ink in it, so a 1-pixel line stays."""
        x0, y0 = int(part[0] * self.w), int(part[1] * self.h)
        x1, y1 = int(part[2] * self.w), int(part[3] * self.h)
        x0 -= x0 % 8  # start on a byte
        f = max(1, math.ceil(max(x1 - x0, y1 - y0) / max_side))
        if dpi_cap:
            f = max(f, round(self.dpi / dpi_cap))
        ow, oh = (x1 - x0) // f, (y1 - y0) // f
        if ow < 1 or oh < 1:
            return None
        out = np.empty((oh, ow), np.uint8)
        b0, b1 = x0 // 8, (x0 + ow * f + 7) // 8
        # Whole output rows a band, 64 at most, fewer for a very wide sheet.
        band = f * max(1, min(64, BAND_MAX_PIXELS // max(1, ow * f * f)))
        for r in range(0, oh * f, band):
            n = min(band, oh * f - r) // f
            rows = self.ink[y0 + r : y0 + r + n * f, b0:b1]
            px = np.unpackbits(rows, axis=1)[:, : ow * f]
            ink = px.reshape(n, f, ow, f).sum(axis=(1, 3), dtype=np.uint32)
            out[r // f : r // f + n] = 255 - np.minimum(ink * 255 // f, 255).astype(np.uint8)
        return out


def dpi_of(im):
    d = im.info.get("dpi")
    try:
        v = float(d[0]) if d else 0.0
    except (TypeError, ValueError, IndexError):
        v = 0.0
    return v if v > 0 else 200.0


def tiff_rows(im):
    tags = getattr(im, "tag_v2", {}) or {}
    comp = {1: "none", 2: "CCITT RLE", 3: "CCITT G3", 4: "CCITT G4", 5: "LZW", 7: "JPEG", 8: "Deflate", 32773: "PackBits"}
    rows = [["Compression", comp.get(tags.get(259), str(tags.get(259, "")))]]
    for tag, key in ((305, "Software"), (269, "Document name"), (270, "Description")):
        v = tags.get(tag)
        if isinstance(v, str) and v.strip():
            rows.append([key, v.strip()[:200]])
    return rows


def open_tiff(data):
    """Pillow reads the header and the tags only: no pixels."""
    if not data.startswith(TIFF_MAGICS):
        return None
    try:
        im = Image.open(io.BytesIO(data))
        return im if im.format == "TIFF" else None
    except Exception:
        return None


def read_tif(data, job):
    im = open_tiff(data)
    if im is None:
        raise NotMine("not a TIFF")
    pages = getattr(im, "n_frames", 1)
    im.seek(0)
    raster = Raster(os.path.join(job, "in.bin"), im)
    rows = [["Format", "TIFF raster"], ["Pages", str(pages)]] + tiff_rows(im)
    warnings = ["Only page 1 of %d was read." % pages] if pages > 1 else []
    return raster, rows, {}, warnings


def smf_names(raw):
    """The names an SMF holds as C strings after its 01 B0 marker: the
    document title first, then the layer names."""
    names = []
    for m in re.finditer(rb"\x01\xb0([\x20-\x7e]{1,300})\x00", raw[:65536]):
        s = m.group(1).decode("ascii").strip()
        if s and s not in names:
            names.append(s)
    return names


def read_smf(data, job):
    raw = data
    if raw[:2] == b"\x1f\x8b":
        d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            raw = d.decompress(data, SMF_MAX_BYTES + 1)
        except zlib.error:
            raise NotMine("a broken gzip")
    if not raw.startswith(SMF_MAGIC):
        raise NotMine("not an Imagenation file")
    if len(raw) > SMF_MAX_BYTES:
        raise TooLarge("The SMF is past the %d MB this Reader reads." % (SMF_MAX_BYTES // 1024 // 1024))
    im, at = None, -1
    for magic in TIFF_MAGICS:
        at = raw.find(magic)
        for _ in range(SMF_TIFF_TRIES):
            if at < 0:
                break
            im = open_tiff(raw[at:])
            if im is not None:
                break
            at = raw.find(magic, at + 1)
        if im is not None:
            break
    if im is None:
        raise NotMine("no raster inside")
    names = smf_names(raw)
    title = names[0] if names else ""
    layers = [n for n in names[1:] if n != title]
    path = os.path.join(job, "raster.tif")
    with open(path, "wb") as f:
        f.write(raw[at:])
    del raw
    try:
        raster = Raster(path, im)
    finally:
        os.remove(path)
    rows = [["Format", "Imagenation SMF raster"]]
    if layers:
        rows.append(["Layers", ", ".join(layers)])
    rows += tiff_rows(im)
    return raster, rows, {"title": title}, []


# ── HP-GL/2 plots ─────────────────────────────────────────────────────────


class Plot:
    """The lines of an HP-GL/2 plot, in mm, drawn at any scale."""

    def __init__(self, data):
        from ezdxf.addons.hpgl2 import api  # MIT; to_dxf only

        try:
            doc = api.to_dxf(data, color_mode=api.ColorMode.ACI)
        except MemoryError:
            raise
        except Exception:
            # `.000` is a generic extension: bytes ezdxf cannot plot are no
            # plot of this Reader's.
            raise NotMine("no HP-GL/2 plot")
        self.lines, self.solids = [], []
        for e in doc.modelspace():
            t = e.dxftype()
            lw = e.dxf.lineweight if e.dxf.hasattr("lineweight") and e.dxf.lineweight > 0 else 25
            if t == "LINE":
                pts = [(e.dxf.start.x, e.dxf.start.y), (e.dxf.end.x, e.dxf.end.y)]
            elif t == "LWPOLYLINE":
                pts = [p[:2] for p in e.get_points("xy")]
                if e.closed and pts:
                    pts.append(pts[0])
            elif t == "SOLID":
                v = [e.dxf.get(k) for k in ("vtx0", "vtx1", "vtx3", "vtx2")]
                self.solids.append(np.array([(p.x, p.y) for p in v if p is not None], np.float64))
                continue
            else:
                continue
            if len(pts) >= 2:
                self.lines.append((np.array(pts, np.float64), lw / 100.0))
        allpts = [a for a, _ in self.lines] + self.solids
        if not allpts:
            raise NotMine("an empty plot")
        # 1 drawing unit of ezdxf's DXF is 1 plot unit: 0.025 mm.
        for a, _ in self.lines:
            a *= PLU_MM
        for a in self.solids:
            a *= PLU_MM
        xy = np.vstack(allpts)
        self.x0, self.y0 = xy.min(axis=0)
        self.x1, self.y1 = xy.max(axis=0)
        self.w_mm, self.h_mm = self.x1 - self.x0, self.y1 - self.y0
        if self.w_mm <= 0 or self.h_mm <= 0:
            raise NotMine("an empty plot")

    def size_mm(self):
        return (self.w_mm, self.h_mm)

    def picture(self, part, max_side, dpi_cap):
        import cv2

        pw, ph = self.w_mm * (part[2] - part[0]), self.h_mm * (part[3] - part[1])
        px_mm = max_side / max(pw, ph)
        if dpi_cap:
            px_mm = min(px_mm, dpi_cap / MM_PER_IN)
        ow, oh = int(pw * px_mm), int(ph * px_mm)
        if ow < 1 or oh < 1:
            return None
        img = np.full((oh, ow), 255, np.uint8)
        # Paper y runs up, the picture's y runs down. Coordinates in 1/16 px.
        ox = self.x0 + part[0] * self.w_mm
        top = self.y1 - part[1] * self.h_mm
        sh = 4
        k = px_mm * (1 << sh)

        def to_px(a):
            return np.stack([(a[:, 0] - ox) * k, (top - a[:, 1]) * k], axis=1).round().astype(np.int32)

        by_width = {}
        for a, lw in self.lines:
            by_width.setdefault(max(1, round(lw * px_mm)), []).append(to_px(a))
        for t, polys in by_width.items():
            cv2.polylines(img, polys, False, 0, thickness=t, lineType=cv2.LINE_AA, shift=sh)
        if self.solids:
            cv2.fillPoly(img, [to_px(s) for s in self.solids], 0, lineType=cv2.LINE_AA, shift=sh)
        return img


def read_hpgl(data):
    head = data[:4096]
    if not (HPGL_ENTER.search(head) or HPGL_START.match(head)):
        raise NotMine("not an HP-GL/2 plot")
    plot = Plot(data)
    rows = [["Format", "HP-GL/2 plot"]]
    m = re.search(rb'BP\s*1\s*,\s*"([^"]{1,200})"', head)
    name = m.group(1).decode("latin-1").strip() if m else ""
    if name:
        rows.append(["Plot name", name])
    widths = sorted({float(w) for w in re.findall(rb"PW\s*([0-9]*\.?[0-9]+)", data)})
    if widths:
        rows.append(["Pen widths mm", ", ".join("%g" % w for w in widths[:20])])
    rows.append(["Polylines", str(len(plot.lines))])
    title = re.sub(r"\.(dgn|dwg|dxf)$", "", name, flags=re.I)
    return plot, rows, {"title": title}, []


# ── The step ──────────────────────────────────────────────────────────────


def title_rows(title):
    """The title a file names, its parts split on ';', and the number in
    brackets (on these drawings the sheet number the margin shows)."""
    if not title:
        return [], ""
    clean = re.sub(r"\s*\((smf)\)\s*$", "", title, flags=re.I).strip()
    rows = [["Title", clean]]
    ref = re.findall(r"\(\s*(?:WT)?\s*(\d+)\s*\)", clean)
    base = re.sub(r"\([^)]*\)", "", clean)
    parts = [p.strip() for p in base.split(";") if p.strip()]
    for i, p in enumerate(parts, 1):
        rows.append(["Part %d" % i, p])
    if ref:
        rows.append(["Sheet ref", ref[-1]])
    return rows, clean


def read_sheet(request, data, job):
    ext = str((request.get("file") or {}).get("ext", "")).lower()
    if ext in ("tif", "tiff"):
        return read_tif(data, job)
    if ext == "smf":
        return read_smf(data, job)
    if ext == "000":
        return read_hpgl(data)
    raise NotMine("not a type of this Reader")


def make_pictures(sheet, title, opts, job):
    page_px = int(opts.get("page_px", 2800))
    wanted = [("The whole sheet", (0.0, 0.0, 1.0, 1.0), page_px, None)]
    if opts.get("crops", True) is not False:
        wanted += [(c, part, CROP_MAX_SIDE, CROP_DPI) for c, part in CROPS]
    pictures = []
    for i, (caption, part, side, cap) in enumerate(wanted):
        img = sheet.picture(part, side, cap)
        if img is None:
            continue
        if min(img.shape) < MIN_SIDE:
            k = MIN_SIDE / min(img.shape)
            if k > MAX_UPSCALE:
                continue
            size = (math.ceil(img.shape[1] * k), math.ceil(img.shape[0] * k))
            img = np.asarray(Image.fromarray(img, "L").resize(size, Image.LANCZOS))
        name = "sheet.png" if i == 0 else "crop%d.png" % i
        Image.fromarray(img, "L").save(os.path.join(job, name), optimize=True)
        cap_text = caption + (": " + title if title else "")
        pictures.append({"file": name, "mime": "image/png", "caption": cap_text[:200]})
    return pictures


def facts_of(sheet, rows, meta):
    """The Drawing tab's rows, the title, and the text: all with no model."""
    trows, title = title_rows(meta.get("title", ""))
    w_mm, h_mm = sheet.size_mm()
    rows = rows[:1] + trows + rows[1:]
    if isinstance(sheet, Raster):
        rows += [["Width px", str(sheet.w)], ["Height px", str(sheet.h)], ["DPI", "%g" % sheet.dpi]]
    rows += [["Width mm", "%.0f" % w_mm], ["Height mm", "%.0f" % h_mm]]
    fmt = rows[0][1]
    text = "%s, a drawing sheet of %.0f x %.0f mm." % (fmt, w_mm, h_mm)
    if title:
        text += " Title: %s." % title
    extra = [v for k, v in trows if k.startswith("Part") or k == "Sheet ref"]
    if extra:
        text += " Names: %s." % ", ".join(extra)
    return {"rows": rows, "title": title, "text": text, "fmt": fmt}


def step(request, data, job):
    opts = request.get("options") or {}
    try:
        sheet, rows, meta, warnings = read_sheet(request, data, job)
    except NotMine:
        return {"status": "not_mine"}
    except TooLarge as e:
        return {"status": "failed", "warnings": [str(e)]}
    facts = facts_of(sheet, rows, meta)
    pictures = make_pictures(sheet, facts["title"], opts, job)
    title = facts["title"]
    return {
        "status": "ok",
        "warnings": warnings,
        "calls": [
            {
                "call": "tool",
                "tool": "file_tabs_write",
                "input": {
                    "tabs": [
                        {
                            "name": "Drawing",
                            "columns": [{"name": "Key", "type": "text"}, {"name": "Value", "type": "text"}],
                            "rows": facts["rows"],
                        }
                    ],
                    "description": ("%s%s." % (facts["fmt"], ": " + title if title else ""))[:300],
                    "text": facts["text"],
                    "pictures": pictures,
                },
            }
        ],
    }


def main():
    job = sys.argv[1]
    with open(os.path.join(job, "request.json"), encoding="utf-8") as f:
        request = json.load(f)
    with open(os.path.join(job, "in.bin"), "rb") as f:
        data = f.read()
    result = step(request, data, job)
    with open(os.path.join(job, "result.json"), "w", encoding="utf-8") as f:
        json.dump(result, f)


if __name__ == "__main__":
    main()
