#!/usr/bin/env python3
"""The parser service's CAD tier: three child modes, each run by the parser's
job process (server/parser/src/cad.ts) in its own process group under the
job's time limit, inside the parser container's memory limit.

    cad.py --dwf-render <src> <outdir> <dpi> <max_sheets>
    cad.py --dwg-render <src> <outdir> <dpi>
    cad.py --dwg-crop   <src> <outdir> <spec.json>

Each writes `index.json` (and PNGs) into <outdir> and exits 0, or exits
non-zero with its reason on stderr when the drawing cannot be read at all. A
render that blows the memory limit is killed by the kernel: the parser
answers `crashed`, the brain keeps the drawing as a file.

  --dwf-render  per-sheet rasters of an Autodesk DWF plot set, rendered by
                ezdwf (MIT) onto a fixed 33-inch page, which is what keeps
                small text legible. index.json: {sheet_count, skipped,
                capped, sheets:[{index, name, file}]}.
  --dwg-render  ONE pass that parses AND rasters an AutoCAD drawing's model
                space. DWG magic (AC1xxx) takes the conversion chain:
                dwg2dxf (LibreDWG, GPL, invoked as a subprocess binary only,
                never linked) with ezdwg (MIT) as the fallback for files
                dwg2dxf mangles; anything else is tried as native DXF
                (converter "none"). Everything downstream of DXF is one ezdxf
                path: the registry (layers, texts, blocks, counts) and the
                bones (dwg_bones.py: segments, a snapped network of nodes,
                every insert with its box, per-circuit rows on `Circuit
                <name>` layers), then model.png.
  --dwg-crop    close-up crops of ONE drawing for the image check
                (dwg_crop.py): point and path items, zoomed so the smallest
                text in the window reads at about 14 px (long edge at most
                2000 px), the trace overlaid in fixed colours, plus a sheet
                overview.

The parser container has no network route out; nothing here fetches.
Moved from the media sidecar (its app.py), whose HTTP server, yt-dlp and
caption routes were removed with it; these workers are unchanged.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

# DWG crops (the image check): the child stops starting new crops at
# CROP_BUDGET_S and says which items it cut; the job's kill is the backstop.
CROP_BUDGET_S = 150

# ── CAD render page ──────────────────────────────────────────────────────
# BOTH CAD renderers (ezdxf for DWG/DXF, ezdwf for DWF) floor every stroke at
# a minimum width in POINTS — 1/72 inch of the FIGURE. So the page size, not
# the dpi, sets how heavy a line looks relative to the drawing: dpi adds
# pixels to the same picture, and a bold blob at 600 dpi is a sharper bold
# blob. On the libraries' small default pages a real hairline came out around
# 5x too heavy and small text (line numbers, title-block dates, general notes)
# filled in solid and unreadable — the whole reason a drawing goes to a vision
# model. 33 inches on the long edge (about A0) puts the floor back under a
# real pen width. SQUARE so the same page serves landscape and portrait
# sheets alike; `bbox_inches="tight"` then crops it to the drawing's own
# aspect, so nothing is paid for the unused half.
RENDER_PAGE_INCHES = 33.0
# White paper, no padding, cropped to the ink. `facecolor` is explicit
# because a figure saved with a transparent ground reads as black-on-black in
# half the viewers that later open it.
SAVEFIG_OPTS = {"facecolor": "white", "bbox_inches": "tight", "pad_inches": 0.0}


def cad_page_inches(layout) -> tuple[float, float]:
    """Figure size for a DXF layout: the drawing's own aspect, with its long
    edge at RENDER_PAGE_INCHES. Falls back to a square when the extents cannot
    be read — a rendered drawing with wasted margin beats no drawing."""
    ratio = 1.0
    try:
        from ezdxf import bbox  # noqa: PLC0415 — child-only import

        ext = bbox.extents(layout, fast=True)
        if ext.has_data and ext.size.x > 0 and ext.size.y > 0:
            ratio = ext.size.y / ext.size.x
    except Exception:
        ratio = 1.0
    # Clamp the extreme shapes: a strip drawing must not produce a 1-inch edge
    # (its stroke floor would swamp the picture) or a 300-inch one.
    ratio = min(max(ratio, 0.2), 5.0)
    if ratio <= 1.0:
        return (RENDER_PAGE_INCHES, RENDER_PAGE_INCHES * ratio)
    return (RENDER_PAGE_INCHES / ratio, RENDER_PAGE_INCHES)


def png_is_blank(path: str) -> bool:
    """True when a saved render carries essentially no ink.

    A renderer that paints nothing does not raise: matplotlib saves an empty
    canvas exactly like a full one, so "success" alone never meant the drawing
    is actually IN the image. This is the only cheap check that can tell the
    difference, and a blank page is worse than no page — it looks like content
    to every surface downstream and answers no question.

    Measured on a thumbnail, so a 30 MP render costs a fixed fraction of a
    second. The threshold is deliberately far from both observed extremes: a
    real P&ID renders 8-14% ink, and the blank one that started this had a
    single non-white pixel out of three million (0.00003%). A probe that
    cannot run returns False — never fail a good render on a broken probe.
    """
    try:
        from PIL import Image  # noqa: PLC0415 — probe-only import

        with Image.open(path) as im:
            grey = im.convert("L")
            grey.thumbnail((1000, 1000))
            hist = grey.histogram()
    except Exception:
        return False
    total = sum(hist)
    if total == 0:
        return True
    return sum(hist[:250]) / total < 0.0005


def dwf_render_worker(src: str, outdir: str, dpi: int, max_sheets: int) -> int:
    """`--dwf-render` child entry: raster every 2D sheet of `src` into
    `outdir` and write `index.json` describing what happened. Runs in its own
    process (group-killed on timeout by the parser job), so a wedged or
    memory-hungry render dies HERE, never in the parser's server. Per sheet:

      - files and fallback names are keyed to the sheet's TRUE index in the
        set, so a failed sheet shifts nothing and no path is ever reused;
      - the sheet is drawn on OUR page (RENDER_PAGE_INCHES), not ezdwf's own
        small figure — the stroke floor is a width in points, so the page is
        what decides legibility (see the constant);
      - the output is pixel-capped: when page × dpi would exceed
        MAX_RENDER_PIXELS the dpi is scaled down for that sheet instead of
        allocating an unbounded canvas;
      - a sheet that renders BLANK is counted as skipped, never stored (a
        white rectangle reads as content to everything downstream);
      - matplotlib figures are closed after every sheet (harmless if ezdwf
        uses the OO API, load-bearing if it goes through pyplot's registry).

    Exits non-zero only when the whole file is unreadable; a single bad sheet
    is counted in `skipped` and the rest of the set still ships."""
    import ezdwf  # noqa: PLC0415 — child-only import; absent on pre-CAD images

    import matplotlib  # noqa: PLC0415

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt  # noqa: PLC0415

    max_pixels = 30_000_000  # ~6600×4500 output cap, checked on the REAL file
    drawing = ezdwf.read(src)
    sheets = list(drawing.sheets)
    index: dict = {
        "sheet_count": len(sheets),
        "skipped": 0,
        "capped": len(sheets) > max_sheets,
        "sheets": [],
    }

    def png_pixels(path: str) -> int | None:
        try:
            with open(path, "rb") as f:
                head = f.read(24)
            if head[:8] != b"\x89PNG\r\n\x1a\n":
                return None
            return int.from_bytes(head[16:20], "big") * int.from_bytes(head[20:24], "big")
        except OSError:
            return None

    for i, sheet in enumerate(sheets[:max_sheets]):
        fname = f"sheet-{i}.png"
        path = os.path.join(outdir, fname)
        try:
            # Our own page rather than sheet.save_plot()'s: that helper builds
            # a small figure (~5in wide), and ezdwf floors every stroke at 0.5
            # POINTS, so on that page a hairline landed ~5x too fat and small
            # text went solid. Proved it is the floor and not the resolution:
            # rendering the same sheet with linewidth_scale 1.0, 0.35 and 0.2
            # gave BYTE-IDENTICAL output — every stroke already sits on the
            # floor, so scaling them cannot thin anything. RENDER_PAGE_INCHES
            # is the fix; `plot(ax=...)` is ezdwf's supported seam for it.
            #
            # Colour is KEPT (no monochrome=True): the page alone restores
            # legibility, and on a circuitised P&ID colour can carry meaning.
            fig = plt.figure(figsize=(RENDER_PAGE_INCHES, RENDER_PAGE_INCHES))
            ax = fig.add_axes([0, 0, 1, 1])
            ax.set_axis_off()
            ezdwf.plot(sheet, ax=ax)
            # Fixed page ⇒ the pixel cap is a dpi ceiling. Conservative (it
            # assumes the whole square; the tight bbox crops to the sheet's
            # aspect), with the MEASURED guard below as the real backstop.
            eff_dpi = min(dpi, max(50, int((max_pixels / (RENDER_PAGE_INCHES**2)) ** 0.5)))
            fig.savefig(path, dpi=eff_dpi, **SAVEFIG_OPTS)
            pixels = png_pixels(path)
            if pixels is not None and pixels > max_pixels:
                fig.savefig(
                    path,
                    dpi=max(50, int(eff_dpi * (max_pixels / pixels) ** 0.5)),
                    **SAVEFIG_OPTS,
                )
            # A sheet that paints nothing is a skip, not a white rectangle
            # stored as if it were the drawing (see png_is_blank).
            if png_is_blank(path):
                raise ValueError("blank render")
        except Exception:
            try:
                os.unlink(path)
            except OSError:
                pass
            index["skipped"] += 1
            continue
        finally:
            plt.close("all")
        name = str(getattr(sheet, "name", "") or "").strip() or f"sheet {i + 1}"
        index["sheets"].append({"index": i, "name": name, "file": fname})
    with open(os.path.join(outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f)
    return 0


def _try_parse(path: str):
    import ezdxf  # noqa: PLC0415 - child-only import

    try:
        return ezdxf.readfile(path)
    except Exception:
        return None


def open_cad(src: str, outdir: str):
    """`src` as an ezdxf document and the converter that made it, or
    (None, None) with the reason on stderr. DWG magic takes the conversion
    chain (dwg2dxf, then ezdwg), anything else is read as DXF. Shared by the
    render and the crop children so both read a drawing the same way."""
    doc = None
    converter = None
    with open(src, "rb") as f:
        head = f.read(6)
    if not re.match(rb"^AC1\d{3}$", head):
        # Not DWG bytes — try native DXF. ezdxf.readfile handles both ASCII
        # and binary DXF; recover.readfile mops up files a strict parse
        # rejects (the common state of hand-edited or third-party exports).
        doc = _try_parse(src)
        if doc is None:
            try:
                from ezdxf import recover  # noqa: PLC0415 — child-only import

                doc, _auditor = recover.readfile(src)
            except Exception:
                doc = None
        if doc is None:
            sys.stderr.write("not DWG bytes and not parseable DXF\n")
            return None, None
        converter = "none"
    if doc is None:
        dxf_a = os.path.join(outdir, "a.dxf")
        # Tier 1 guarded: a missing binary (FileNotFoundError), a hung conversion
        # (TimeoutExpired) or any other failure must fall THROUGH to ezdwg, not
        # kill the child before the fallback ever runs.
        try:
            proc = subprocess.run(
                ["dwg2dxf", "-o", dxf_a, src], capture_output=True, text=True, timeout=120
            )
            if proc.returncode == 0 and os.path.isfile(dxf_a):
                doc = _try_parse(dxf_a)
                if doc is not None:
                    converter = "dwg2dxf"
        except Exception:
            pass  # tier 2 decides
    if doc is None:
        # Tier 2 guarded too: the import (pre-DWG image), read() (unsupported
        # file) and export_dxf() can all raise — every failure takes the ONE
        # curated exit instead of a raw traceback.
        try:
            import ezdwg  # noqa: PLC0415 — fallback tier; absent on pre-DWG images

            dxf_b = os.path.join(outdir, "b.dxf")
            ezdwg.read(src).export_dxf(dxf_b)
            doc = _try_parse(dxf_b)
        except Exception:
            doc = None
        if doc is None:
            sys.stderr.write("no converter produced a parseable DXF\n")
            return None, None
        converter = "ezdwg"

    return doc, converter


def dwg_render_worker(src: str, outdir: str, dpi: int) -> int:
    """`--dwg-render` child entry: get `src` into ezdxf, extract the model-
    space registry, raster the model space, and write `index.json` + a
    `model.png` into `outdir`. Own process (the parser job group-kills it on
    timeout), so a wedged conversion or render dies here, never in the
    parser's server, and its exit frees every matplotlib figure by
    construction.

    Input sniff decides the road in:
      - DWG magic (AC1xxx) → the conversion chain, decided by the 2026-08-31
        bake-off on real drawings:
          1. `dwg2dxf` (LibreDWG) — a subprocess call, never a linked library
             (GPLv3; the process boundary is the licence boundary);
          2. `ezdwg.export_dxf` (MIT) when dwg2dxf's output fails ezdxf's
             parse — dwg2dxf 0.13.3 emits structurally invalid DXF on some
             real files, and ezdwg reads exactly those.
      - anything else → tried as native DXF (ASCII or binary — ezdxf reads
        both; `recover` mops up malformed files) and reported as converter
        "none". No format gate beyond "ezdxf can read it": a junk upload
        fails the read and takes the same curated exit as a DWG no converter
        can crack.
    Downstream of DXF there is ONE path: ezdxf for both registry and render
    (its drawing add-on expands INSERT blocks — ezdwg's own plot() does not,
    which is why it renders nothing usable on block-heavy drawings).

    The registry is capped (texts/layers/text length) so the reply stays a
    few MB whatever the drawing holds; the render carries the same measured
    output-pixel guard as the DWF worker. Exits non-zero only when no road
    produces a parseable DXF document."""
    import ezdxf  # noqa: PLC0415 — child-only import; absent on pre-DWG images

    import matplotlib  # noqa: PLC0415

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt  # noqa: PLC0415
    from ezdxf.addons.drawing import Frontend, RenderContext  # noqa: PLC0415
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend  # noqa: PLC0415
    from ezdxf.addons.drawing.properties import LayoutProperties  # noqa: PLC0415

    max_pixels = 30_000_000

    doc, converter = open_cad(src, outdir)
    if doc is None:
        return 1

    index = dwg_registry(doc, converter)

    png = os.path.join(outdir, "model.png")

    def render_png(document) -> str | None:
        """Raster `document`'s model space to model.png. Returns None on
        success, the error string on failure (with any partial PNG removed).

        A BLANK output counts as a failure. Nothing here raises when a drawing
        paints nothing — matplotlib saves an empty canvas as happily as a full
        one — so without the ink probe the worker reported success, the app
        stored a white rectangle, and the only clue was its byte size."""
        try:
            msp_layout = document.modelspace()
            # Page shaped to the DRAWING, long edge pinned to the page size.
            # A square page would work — equal aspect centres the drawing in it
            # — but a landscape P&ID would then carry ~35% white margin into
            # every vision call. `bbox.extents(fast=True)` is ~0.6s on a 9.7k
            # entity drawing and uses cached bounding boxes; any failure falls
            # back to the square, which is wasteful but never wrong.
            fig = plt.figure(figsize=cad_page_inches(msp_layout))
            ax = fig.add_axes([0, 0, 1, 1])
            ax.set_axis_off()
            # ACI colour 7 has NO fixed colour: ezdxf resolves it against the
            # layout BACKGROUND, and the default layout is dark, so 7 comes out
            # WHITE — invisible on matplotlib's white page. Overriding the
            # RenderContext's own properties does not help either: draw_layout()
            # rebuilds them from the layout unless they are passed in, which
            # silently discards the override. Drawings whose entities carry
            # explicit colours rendered fine and hid this for weeks; a drawing
            # that is all colour 7 rendered ENTIRELY BLANK (a client box 2026-09-02:
            # 9681 entities, exactly one non-white pixel in the output).
            lp = LayoutProperties.from_layout(msp_layout)
            lp.set_colors("#FFFFFF")  # white page ⇒ colour 7 resolves to black
            # `adjust_figure=False` keeps the page we asked for: the backend
            # otherwise rescales the figure to the drawing's aspect, which on
            # the old 16×10 page left ~7×4.8in. Page size is what decides
            # stroke weight — ezdxf floors every stroke at a width in POINTS,
            # so a small page makes hairlines ~5× too heavy and fills small
            # text in solid. dpi cannot fix that; only a bigger page can.
            Frontend(
                RenderContext(document), MatplotlibBackend(ax, adjust_figure=False)
            ).draw_layout(msp_layout, finalize=True, layout_properties=lp)
            # The page is fixed, so the output-pixel cap maps straight to a dpi
            # ceiling — clamp BEFORE the first savefig instead of paying an
            # over-budget render only to redo it smaller. Conservative: it
            # assumes the full square page, while the tight bbox below crops to
            # the drawing's own aspect. The measured guard stays as backstop.
            eff_dpi = min(dpi, max(50, int((max_pixels / (RENDER_PAGE_INCHES**2)) ** 0.5)))
            fig.savefig(png, dpi=eff_dpi, **SAVEFIG_OPTS)
            with open(png, "rb") as f:
                head = f.read(24)
            if head[:8] == b"\x89PNG\r\n\x1a\n":
                pixels = int.from_bytes(head[16:20], "big") * int.from_bytes(head[20:24], "big")
                if pixels > max_pixels:
                    # Nested guard: a failed DOWNSCALE must not delete the good
                    # first render — only a genuinely unusable output is removed.
                    try:
                        fig.savefig(
                            png,
                            dpi=max(50, int(eff_dpi * (max_pixels / pixels) ** 0.5)),
                            **SAVEFIG_OPTS,
                        )
                    except Exception:
                        pass  # keep the over-budget-but-valid first PNG
            if png_is_blank(png):
                try:
                    os.unlink(png)
                except OSError:
                    pass
                return "the render produced a blank image (no ink on the page)"
            return None
        except Exception as err:
            try:
                os.unlink(png)
            except OSError:
                pass
            return f"{type(err).__name__}: {err}"[:500]
        finally:
            plt.close("all")

    # Registry without pixels still ships; the parent tolerates a missing
    # model.png. The reason is recorded so the app side can say WHY the
    # drawing has no image child instead of silently emitting nothing.
    render_error = render_png(doc)

    if render_error is not None and converter == "dwg2dxf":
        # The registry parsed but the RENDER failed: dwg2dxf can emit a DXF
        # that parses yet is missing block DEFINITIONS the renderer needs
        # (anonymous "*U" blocks on real drawings). ezdwg's own export keeps
        # them — retry the render ONCE from its DXF. The registry above stays
        # from the first parse (already extracted, caps applied); only the
        # pixels change provenance, recorded as `render_converter`.
        try:
            import ezdwg  # noqa: PLC0415 — fallback tier; absent on pre-DWG images

            dxf_b = os.path.join(outdir, "b.dxf")
            if not os.path.isfile(dxf_b):
                ezdwg.read(src).export_dxf(dxf_b)
            doc_b = _try_parse(dxf_b)
            if doc_b is not None:
                retry_error = render_png(doc_b)
                if retry_error is None:
                    render_error = None
                    index["render_converter"] = "ezdwg"
                else:
                    render_error = f"{render_error} (ezdwg render retry: {retry_error})"[:500]
        except Exception:
            pass  # keep the original render_error — the retry is best-effort

    index["render_error"] = render_error

    with open(os.path.join(outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f)
    return 0


def dwg_crop_worker(src: str, outdir: str, spec_path: str) -> int:
    """`--dwg-crop` child entry: read the drawing (open_cad), plan and render
    the spec's crops (dwg_crop.py) and write `index.json` plus one PNG per
    crop and the overview into `outdir`. Exits non-zero only when the
    drawing cannot be read or the spec is malformed."""
    import dwg_crop  # noqa: PLC0415 - child-only; sits next to this file

    try:
        with open(spec_path, encoding="utf-8") as f:
            spec = dwg_crop.parse_spec(json.load(f))
    except (ValueError, OSError) as err:
        sys.stderr.write(f"crop spec: {err}\n")
        return 1
    started = time.time()
    doc, converter = open_cad(src, outdir)
    if doc is None:
        return 1
    index = dwg_crop.render(doc, spec, outdir, deadline=started + CROP_BUDGET_S)
    index["converter"] = converter
    with open(os.path.join(outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, allow_nan=False)
    return 0


def dwg_registry(doc, converter) -> dict:
    """The model-space registry of a parsed ezdxf document: layers, texts,
    attribute blocks and entity counts, plus the bones (segments, nodes,
    every insert, circuits; see dwg_bones.py) from the same entity pass.
    Capped (texts/layers/text length, and a character budget per bones
    list) so the reply stays a few MB whatever the drawing holds. Its own
    function so the registry can be tested on a synthetic document without
    a render."""
    import dwg_bones  # noqa: PLC0415 - child-only; sits next to this file

    max_texts = 20_000
    max_text_len = 512
    max_layers = 1_000
    max_blocks = 20_000

    msp = doc.modelspace()
    layer_counts: dict = {}
    type_counts: dict = {}
    texts = []
    blocks = []
    entities = 0
    texts_capped = False
    blocks_capped = False
    # Every attribute value is also in `texts`; this bounds what `blocks`
    # adds to the reply, whatever the per-block tag count.
    max_block_chars = 2_000_000
    block_chars = 0

    # The bones pass (segments, every insert) gathers in this same loop; the
    # network is built after it. Best effort: a geometry failure is reported
    # as geometry_error and never costs the registry above it.
    coord = dwg_bones.coord
    max_raw_segments = 400_000
    max_raw_inserts = 200_000
    seg_raw: list = []
    insert_raw: list = []
    box_cache: dict = {}
    skipped: dict = {}
    geometry_error = None

    def gather(e, etype: str, layer: str) -> None:
        nonlocal geometry_error
        if geometry_error is not None:
            return
        try:
            if etype in dwg_bones.SEGMENT_TYPES:
                handle = str(getattr(e.dxf, "handle", "") or "")
                for seg in dwg_bones.entity_segments(e):
                    seg.update(layer=layer, handle=handle, type=etype)
                    seg_raw.append(seg)
            elif etype == "INSERT":
                rec = dwg_bones.insert_record(e, doc, box_cache)
                rec["layer"] = layer
                insert_raw.append(rec)
            elif etype in dwg_bones.SKIPPED_CURVES:
                skipped[etype] = skipped.get(etype, 0) + 1
        except Exception:  # one odd entity: count it, keep going
            skipped["unreadable"] = skipped.get("unreadable", 0) + 1
        if len(seg_raw) > max_raw_segments or len(insert_raw) > max_raw_inserts:
            # A partial network would show open ends that are not there, so
            # past this size there is no geometry at all, and it says why.
            geometry_error = (
                f"more than {max_raw_segments} segments or {max_raw_inserts} inserts:"
                " geometry not built"
            )
            seg_raw.clear()
            insert_raw.clear()

    def add_text(entity, layer: str) -> None:
        """Harvest one text-bearing entity into `texts` under the shared caps."""
        nonlocal texts_capped
        raw = entity.plain_text() if entity.dxftype() == "MTEXT" else entity.dxf.text
        text = " ".join(str(raw).split())[:max_text_len]
        if not text:
            return
        if len(texts) >= max_texts:
            texts_capped = True
            return
        point = entity.dxf.insert if hasattr(entity.dxf, "insert") else None
        texts.append(
            {
                "text": text,
                "layer": layer,
                "x": coord(point[0]) if point is not None else None,
                "y": coord(point[1]) if point is not None else None,
            }
        )

    for e in msp:
        entities += 1
        etype = e.dxftype()
        type_counts[etype] = type_counts.get(etype, 0) + 1
        layer = str(getattr(e.dxf, "layer", "") or "")
        layer_counts[layer] = layer_counts.get(layer, 0) + 1
        gather(e, etype, layer)
        if etype in ("TEXT", "MTEXT"):
            try:
                add_text(e, layer)
            except Exception:
                continue
        elif etype == "INSERT":
            # Block ATTRIBs carry the real content on attribute-driven
            # drawings (title blocks, circuit/line-number tags) — a top-level
            # TEXT/MTEXT sweep alone misses hundreds of values per file.
            # Each attrib also lands in `blocks` keyed by its TAG, one record
            # per INSERT: on circuitized P&IDs a LineNumber block holds
            # LINENO and CIRCUIT side by side, and the flat Texts list loses
            # that pairing (found on a client brain 2026-10-23).
            attribs: dict = {}
            for attrib in getattr(e, "attribs", None) or []:
                try:
                    type_counts["ATTRIB"] = type_counts.get("ATTRIB", 0) + 1
                    add_text(attrib, str(getattr(attrib.dxf, "layer", "") or ""))
                    tag = str(getattr(attrib.dxf, "tag", "") or "").strip()
                    value = " ".join(str(attrib.dxf.text or "").split())[:max_text_len]
                    if tag and not attribs.get(tag):
                        attribs[tag] = value
                except Exception:
                    continue
            if any(attribs.values()):
                size = sum(len(k) + len(v) for k, v in attribs.items())
                if len(blocks) >= max_blocks or block_chars + size > max_block_chars:
                    blocks_capped = True
                else:
                    try:
                        point = e.dxf.insert
                    except Exception:
                        point = None
                    block_chars += size
                    blocks.append(
                        {
                            "block": str(getattr(e.dxf, "name", "") or ""),
                            "layer": layer,
                            "handle": str(getattr(e.dxf, "handle", "") or ""),
                            "x": coord(point[0]) if point is not None else None,
                            "y": coord(point[1]) if point is not None else None,
                            "attribs": attribs,
                        }
                    )

    layers = sorted(layer_counts.items(), key=lambda kv: (-kv[1], kv[0]))
    index = {
        "converter": converter,
        "version": doc.dxfversion,
        "entities": entities,
        "capped": texts_capped or len(layers) > max_layers,
        "layers": [{"name": n, "count": c} for n, c in layers[:max_layers]],
        "texts": texts,
        "blocks": blocks,
        # Its own bit: a blocks cap must not make the app call Texts truncated.
        "blocks_capped": blocks_capped,
        "counts": type_counts,
        "render_error": None,
    }
    if geometry_error is None:
        try:
            geo = dwg_bones.geometry_index(seg_raw, insert_raw, texts, blocks, skipped)
            try:
                # A NaN or Infinity would make index.json unparseable app
                # side and lose the whole import, registry included.
                json.dumps(geo, allow_nan=False)
            except ValueError:
                raise ValueError("a number in the geometry is not finite: geometry not built")
            index.update(geo)
        except (dwg_bones.GeometryBudgetExceeded, ValueError) as err:
            geometry_error = str(err)[:500]
        except Exception as err:
            geometry_error = f"{type(err).__name__}: {err}"[:500]
    index["geometry_error"] = geometry_error
    return index


if __name__ == "__main__":
    if len(sys.argv) >= 6 and sys.argv[1] == "--dwf-render":
        sys.exit(dwf_render_worker(sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])))
    if len(sys.argv) >= 5 and sys.argv[1] == "--dwg-render":
        sys.exit(dwg_render_worker(sys.argv[2], sys.argv[3], int(sys.argv[4])))
    if len(sys.argv) >= 5 and sys.argv[1] == "--dwg-crop":
        sys.exit(dwg_crop_worker(sys.argv[2], sys.argv[3], sys.argv[4]))
    sys.stderr.write(__doc__ or "")
    sys.exit(2)
