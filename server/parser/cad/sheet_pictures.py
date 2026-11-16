"""Gray pictures of parts of a raster or plot drawing sheet, with no model.

For a pipeline's step that needs pictures of a sheet it cannot draw itself
(`job.sheetPictures`, server/parser/src/cad.ts): a scanned TIF drawing
(1 bit), an Imagenation SMF raster (gzip or not; one TIFF inside) or an
HP-GL/2 plot (.000).

Run:
    python sheet_pictures.py <input> <ext> <outdir> <spec.json>

The spec is a JSON list of pictures, each a part of the sheet as fractions
(x0, y0, x1, y1), from the top left:
    [{"file": "sheet.png", "part": [0, 0, 1, 1], "maxSide": 2800, "dpiCap": null}]

It writes each picture as an 8 bit gray PNG in <outdir>, and one reply,
<outdir>/sheet-pictures.json:
    {"ok": true, "format": "...", "widthMm": n, "heightMm": n, "pictures": ["sheet.png"]}
or, for a file that is none of the three formats:
    {"ok": false, "notMine": true}

Libraries: the parser's venv (Pillow, numpy, OpenCV, ezdxf). Never ezdxf's
to_pdf or to_pixmap: they need PyMuPDF (AGPL).
"""

from __future__ import annotations

import io
import json
import math
import os
import sys
import zlib

import numpy as np
from PIL import Image

# A plot raster is 1.4 gigapixels. Pillow reads only its tags here; the
# pixels stay 1 bit (libtiff, below), so its bomb check would refuse an
# honest file.
Image.MAX_IMAGE_PIXELS = None

MM_PER_IN = 25.4
PLU_MM = 0.025  # one HP-GL/2 plot unit
SMF_MAGIC = b"|>$$'"
SMF_MAX_BYTES = 64 * 1024 * 1024  # an SMF after gunzip, at most
TIFF_MAGICS = (b"II*\x00", b"MM\x00*")
# The most pixels a raster's header may claim. An honest plot is about 1.4
# gigapixels (44,480 x 30,500); the packed buffer of this many is 500 MB.
# The one check that a header's size is believed, before any buffer is made.
RASTER_MAX_PIXELS = 4_000_000_000
REPLY = "sheet-pictures.json"


class NotMine(Exception):
    pass


# ── Rasters (TIF and SMF) ─────────────────────────────────────────────────


def libtiff():
    """libtiff by ctypes: the system's, else the copy in Pillow's wheel.
    Pillow keeps a 1-bit image as one byte a pixel (1.4 GB for a plot),
    libtiff gives the packed bits (170 MB)."""
    import ctypes
    import ctypes.util
    import glob

    import PIL

    found = [ctypes.util.find_library("tiff")]
    base = os.path.dirname(PIL.__file__)
    found += glob.glob(os.path.join(base, ".dylibs", "libtiff*"))
    found += glob.glob(os.path.join(os.path.dirname(base), "pillow.libs", "libtiff*"))
    found += glob.glob("/usr/lib/*/libtiff.so*")
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
        lib.TIFFReadEncodedStrip.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.c_ssize_t,
        ]
        lib.TIFFSetWarningHandler.argtypes = [ctypes.c_void_p]
        lib.TIFFSetErrorHandler.argtypes = [ctypes.c_void_p]
        lib.TIFFSetWarningHandler(None)
        lib.TIFFSetErrorHandler(None)
        return lib
    raise RuntimeError("no libtiff in this image")


def dpi_of(im) -> float:
    d = im.info.get("dpi")
    try:
        v = float(d[0]) if d else 0.0
    except (TypeError, ValueError, IndexError):
        v = 0.0
    return v if v > 0 else 200.0


class Raster:
    """A 1-bit sheet, kept packed: `ink` holds 8 pixels a byte, bit 1 ink,
    the first pixel in the high bit. Page 1 of the TIFF file at `path`;
    `im` is Pillow's read of its tags."""

    def __init__(self, path, im):
        tags = im.tag_v2
        bits = tags.get(258, 1)
        bits = bits[0] if isinstance(bits, tuple) and bits else bits
        if bits != 1 or tags.get(277, 1) != 1:
            raise NotMine("not a 1-bit raster")
        self.w, self.h = im.size
        if self.w * self.h > RASTER_MAX_PIXELS:
            raise NotMine("a raster of more pixels than any plot")
        self.dpi = dpi_of(im)
        rps = min(int(tags.get(278, self.h)), self.h)
        stride = (self.w + 7) // 8
        lib = libtiff()
        t = lib.TIFFOpen(os.fsencode(path), b"r")
        if not t:
            raise RuntimeError("libtiff could not open the raster")
        try:
            buf = np.zeros(self.h * stride, np.uint8)
            strips = lib.TIFFNumberOfStrips(t)
            for s in range(strips):
                at = s * rps * stride
                size = min(rps, self.h - s * rps) * stride
                if size <= 0:
                    break
                got = lib.TIFFReadEncodedStrip(t, s, buf.ctypes.data + at, size)
                if got < 0:
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
        pixels; a line that crosses the block makes it black."""
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
        band = f * 64
        for r in range(0, oh * f, band):
            n = min(band, oh * f - r) // f
            rows = self.ink[y0 + r : y0 + r + n * f, b0:b1]
            px = np.unpackbits(rows, axis=1)[:, : ow * f]
            ink = px.reshape(n, f, ow, f).sum(axis=(1, 3), dtype=np.uint32)
            out[r // f : r // f + n] = 255 - np.minimum(ink * 255 // f, 255).astype(np.uint8)
        return out


def open_tiff(data):
    """Pillow reads the header and the tags only: no pixels."""
    if not data.startswith(TIFF_MAGICS):
        return None
    try:
        im = Image.open(io.BytesIO(data))
        return im if im.format == "TIFF" else None
    except Exception:
        return None


def read_tif(path, data):
    im = open_tiff(data)
    if im is None:
        raise NotMine("not a TIFF")
    im.seek(0)
    return Raster(path, im), "TIFF raster"


def read_smf(data, outdir):
    raw = data
    if raw[:2] == b"\x1f\x8b":
        d = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            raw = d.decompress(data, SMF_MAX_BYTES)
        except zlib.error:
            raise NotMine("a broken gzip")
        if d.unconsumed_tail:
            raise NotMine("too large after gunzip")
    if not raw.startswith(SMF_MAGIC):
        raise NotMine("not an Imagenation file")
    im, at = None, -1
    for magic in TIFF_MAGICS:
        at = raw.find(magic)
        while at >= 0:
            im = open_tiff(raw[at:])
            if im is not None:
                break
            at = raw.find(magic, at + 1)
        if im is not None:
            break
    if im is None:
        raise NotMine("no raster inside")
    # libtiff reads a file: the TIFF inside, written beside the pictures
    # for the time of the read.
    path = os.path.join(outdir, "sheet-pictures-raster.tif")
    with open(path, "wb") as f:
        f.write(raw[at:])
    try:
        return Raster(path, im), "Imagenation SMF raster"
    finally:
        os.remove(path)


# ── HP-GL/2 plots ─────────────────────────────────────────────────────────


class Plot:
    """The lines of an HP-GL/2 plot, in mm, drawn at any scale."""

    def __init__(self, data):
        from ezdxf.addons.hpgl2 import api  # MIT; to_dxf only

        try:
            doc = api.to_dxf(data, color_mode=api.ColorMode.ACI)
        except (api.Hpgl2DataNotFound, api.EmptyDrawing):
            raise NotMine("no HP-GL/2 data")
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

        # One thread: the parser has one CPU by default (docs/parser.md).
        cv2.setNumThreads(1)
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
            return (
                np.stack([(a[:, 0] - ox) * k, (top - a[:, 1]) * k], axis=1)
                .round()
                .astype(np.int32)
            )

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
    if not (b"\x1b%" in head or head.lstrip()[:2] in (b"IN", b"BP")):
        raise NotMine("not an HP-GL/2 plot")
    return Plot(data), "HP-GL/2 plot"


# ── The pictures ──────────────────────────────────────────────────────────


def sheet_pictures(path, ext, outdir, spec):
    """The reply for one file: the sheet's format and size, and the names
    of the pictures written in `outdir`."""
    with open(path, "rb") as f:
        data = f.read()
    try:
        if ext in ("tif", "tiff"):
            sheet, fmt = read_tif(path, data)
        elif ext == "smf":
            sheet, fmt = read_smf(data, outdir)
        elif ext == "000":
            sheet, fmt = read_hpgl(data)
        else:
            raise NotMine("not one of the three formats")
    except NotMine:
        return {"ok": False, "notMine": True}
    del data
    w_mm, h_mm = sheet.size_mm()
    written = []
    for want in spec:
        img = sheet.picture(want["part"], int(want["maxSide"]), want.get("dpiCap"))
        if img is None:
            continue
        # A name in the folder, never a path out of it.
        name = os.path.basename(want["file"])
        Image.fromarray(img).save(os.path.join(outdir, name), format="PNG", optimize=True)
        written.append(name)
    return {
        "ok": True,
        "format": fmt,
        "widthMm": round(float(w_mm), 1),
        "heightMm": round(float(h_mm), 1),
        "pictures": written,
    }


def main(argv) -> int:
    if len(argv) != 5:
        sys.stderr.write("usage: sheet_pictures.py <input> <ext> <outdir> <spec.json>\n")
        return 2
    path, ext, outdir, spec_path = argv[1:5]
    with open(spec_path, encoding="utf-8") as f:
        spec = json.load(f)
    reply = sheet_pictures(path, ext.lower(), outdir, spec)
    with open(os.path.join(outdir, REPLY), "w", encoding="utf-8") as f:
        json.dump(reply, f)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
