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
                space. DWG magic (AC1xxx) is read by ezdwg's reader (MIT)
                into an in-memory ezdxf document (dwg_read.py, converter
                "ezdwg"; what it could not convert is counted in the
                index's `dwg`). A DGN signature (MicroStation V8, or V7
                2D) is read by ezdgn (MIT) the same way (dgn_read.py,
                converter "ezdgn"; counted in `dgn`). Anything else is
                tried as native DXF (converter "none"). Everything
                downstream of the document is one ezdxf
                path: the registry (layers, texts, blocks, counts) and the
                bones (dwg_bones.py: segments, a snapped network of nodes,
                every insert with its box, per-circuit rows on `Circuit
                <name>` layers), then model.png, framed on the sheet
                (dwg_frame.py: a note far off the sheet is left out and
                listed in `frame.off_sheet`). Last, the symbols
                (dwg_symbols.py): each block an INSERT in model space uses,
                keyed by shape and drawn once as SVG, and each INSERT as a
                placement of its key.
  --dwg-crop    close-up crops of ONE drawing for the image check
                (dwg_crop.py): point and path items, zoomed so the smallest
                text in the window reads at about 14 px (long edge at most
                2000 px), the trace overlaid in fixed colours, plus a sheet
                overview. Also `view` items, the pictures of dwg_render: a
                window, the sheet, or all of model space.

The parser container has no network route out; nothing here fetches.
Moved from the media sidecar (its app.py), whose HTTP server, yt-dlp and
caption routes were removed with it; these workers are unchanged.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
import time

# DWG crops (the image check): the child stops starting new crops at
# CROP_BUDGET_S and says which items it cut; the job's kill is the backstop.
CROP_BUDGET_S = 150
# The render's symbols (dwg_symbols.py): nothing new is keyed or drawn once
# SYMBOL_BUDGET_S has passed since the child started, and at SYMBOL_STOP_S
# the pass is stopped wherever it is (a timer): it gives up its lists, and
# the registry and model.png still ship before the job's kill (its limit less
# 10 s: 230 s for the 240 s render).
SYMBOL_BUDGET_S = 150
SYMBOL_STOP_S = 200

# ── CAD render page ──────────────────────────────────────────────────────
# BOTH CAD renderers (ezdxf for DWG/DXF, ezdwf for DWF) floor every stroke at
# a minimum width in POINTS: 1/72 inch of the FIGURE. So the page size, not
# the dpi, sets how heavy a line looks relative to the drawing: dpi adds
# pixels to the same picture, and a bold blob at 600 dpi is a sharper bold
# blob. On the libraries' small default pages a real hairline came out around
# 5x too heavy and small text (line numbers, title-block dates, general notes)
# filled in solid and unreadable: the whole reason a drawing goes to a vision
# model. 33 inches on the long edge (about A0) puts the floor back under a
# real pen width. SQUARE so the same page serves landscape and portrait
# sheets alike; `bbox_inches="tight"` then crops it to the drawing's own
# aspect, so nothing is paid for the unused half.
RENDER_PAGE_INCHES = 33.0
# White paper, no padding, cropped to the ink. `facecolor` is explicit
# because a figure saved with a transparent ground reads as black-on-black in
# half the viewers that later open it.
SAVEFIG_OPTS = {"facecolor": "white", "bbox_inches": "tight", "pad_inches": 0.0}


def cad_page_inches(layout, frame: dict | None = None) -> tuple[float, float]:
    """Figure size for a DXF layout: the aspect of the sheet it frames (the
    `frame` of dwg_frame.py, else the drawing's own extents), with its long
    edge at RENDER_PAGE_INCHES. Falls back to a square when the extents cannot
    be read: a rendered drawing with wasted margin beats no drawing."""
    ratio = 1.0
    try:
        if frame is not None and frame["framed"]:
            x0, y0, x1, y1 = frame["sheet"]
            ratio = (y1 - y0) / (x1 - x0)
        else:
            from ezdxf import bbox  # noqa: PLC0415 (child-only import)

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


# An absolute path in an error's text: the job's own temp files, which mean
# nothing to a caller and say where the container keeps them.
# Not after a word, a dot, a colon or a slash, so a URL keeps its "//host/…".
# A path with a space in it loses only its first part.
_ABS_PATH = re.compile(r"(?<![\w.:/])/[^\s'\":,)\]]+")


def scrub_paths(text: str) -> str:
    """`text` with every absolute path replaced by <file>."""
    return _ABS_PATH.sub("<file>", text)


def error_text(err: BaseException, limit: int = 500) -> str:
    """An error as a caller may read it: its type and its words, with no
    absolute path in them. An OSError gives only its reason (strerror): its
    file name is a path inside the container."""
    if isinstance(err, OSError) and err.strerror:
        words = err.strerror
    else:
        words = scrub_paths(str(err))
    return f"{type(err).__name__}: {words}"[:limit]


def png_is_blank(path: str) -> bool:
    """True when a saved render carries essentially no ink.

    A renderer that paints nothing does not raise: matplotlib saves an empty
    canvas exactly like a full one, so "success" alone never meant the drawing
    is actually IN the image. This is the only cheap check that can tell the
    difference, and a blank page is worse than no page: it looks like content
    to every surface downstream and answers no question.

    Measured on a thumbnail, so a 30 MP render costs a fixed fraction of a
    second. The threshold is deliberately far from both observed extremes: a
    real P&ID renders 8-14% ink, and the blank one that started this had a
    single non-white pixel out of three million (0.00003%). A probe that
    cannot run returns False: never fail a good render on a broken probe.
    """
    try:
        from PIL import Image  # noqa: PLC0415 (probe-only import)

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


def png_has_no_ink(path: str) -> bool:
    """True when not one pixel of a saved view has ink. A view is often a small
    window on one small thing, so png_is_blank's share of the page, tuned on
    whole sheets, would call a lone circle blank. A probe that cannot run
    returns False, as there."""
    try:
        from PIL import Image  # noqa: PLC0415 (probe-only import)

        with Image.open(path) as im:
            return im.convert("L").point(lambda v: 255 if v < 250 else 0).getbbox() is None
    except Exception:
        return False


def dwf_render_worker(src: str, outdir: str, dpi: int, max_sheets: int) -> int:
    """`--dwf-render` child entry: raster every 2D sheet of `src` into
    `outdir` and write `index.json` describing what happened. Runs in its own
    process (group-killed on timeout by the parser job), so a wedged or
    memory-hungry render dies HERE, never in the parser's server. Per sheet:

      - files and fallback names are keyed to the sheet's TRUE index in the
        set, so a failed sheet shifts nothing and no path is ever reused;
      - the sheet is drawn on OUR page (RENDER_PAGE_INCHES), not ezdwf's own
        small figure: the stroke floor is a width in points, so the page is
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
    import ezdwf  # noqa: PLC0415 (child-only import; absent on pre-CAD images)

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
            # gave BYTE-IDENTICAL output: every stroke already sits on the
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


def _read_or_refuse(read, refused, refused_prefix: str, reader: str):
    """`read()`, or None with one line on stderr: a refusal (`refused`)
    names its reason, and any other fault inside the reader, its Rust
    core's panic included, fails the file cleanly by its error."""
    try:
        return read()
    except refused as err:
        sys.stderr.write(f"no converter produced a parseable DXF ({refused_prefix}{err})\n")
    except (SystemExit, KeyboardInterrupt):
        raise
    except BaseException as err:  # noqa: BLE001 - a Rust panic is a BaseException (pyo3 PanicException)
        sys.stderr.write(f"no converter produced a parseable DXF ({reader}: {error_text(err, 300)})\n")
    return None


def open_cad(src: str, outdir: str):
    """`src` as an ezdxf document, the converter that made it, and the
    converter's notes for the index (a DWG's or a DGN's, None for a DXF), or
    (None, None, None) with the reason on stderr. DWG magic takes ezdwg's
    reader (dwg_read.py), a DGN signature takes ezdgn (dgn_read.py): each
    an in-memory document, nothing written. Anything else is read as DXF.
    Shared by the render and the crop children so both read a drawing the
    same way. `outdir` is not written: the signature is the children's."""
    with open(src, "rb") as f:
        head = f.read(8)
    import dgn_read  # noqa: PLC0415 - child-only; sits next to this file
    import dwg_read  # noqa: PLC0415 - child-only; sits next to this file

    if dwg_read.is_dwg(head):
        # One reader, no fallback.
        got = _read_or_refuse(lambda: dwg_read.read(src), dwg_read.DwgRefused, "ezdwg: ", "ezdwg")
        if got is None:
            return None, None, None
        return got[0], "ezdwg", got[1]
    if dgn_read.is_dgn(head):
        # The data reader first, under its one guard (dgn_read.read_data):
        # when it fails, or with ezdgn 0.3.2, two steps the 0.3.2 way, so a
        # failure names its part: ezdgn's read, then the converter that
        # writes the document.
        def read():
            done, data_error = dgn_read.read_data(src)
            if done is not None:
                return done, None, None
            return None, dgn_read.load(src, data=False), data_error

        got = _read_or_refuse(read, dgn_read.DgnRefused, "", "ezdgn")
        if got is None:
            return None, None, None
        done, loaded, data_error = got
        if done is not None:
            return done[0], "ezdgn", done[1]
        models, facts = loaded
        if data_error:
            facts["data_error"] = data_error
        try:
            doc, notes = dgn_read.build_document(models, facts)
        except Exception as err:
            sys.stderr.write(f"no converter produced a parseable DXF (DGN converter: {error_text(err, 300)})\n")
            return None, None, None
        return doc, "ezdgn", notes
    # Not DWG bytes: try native DXF. ezdxf.readfile handles both ASCII and
    # binary DXF; recover.readfile mops up files a strict parse rejects (the
    # common state of hand-edited or third-party exports).
    doc = _try_parse(src)
    if doc is None:
        try:
            from ezdxf import recover  # noqa: PLC0415 (child-only import)

            doc, _auditor = recover.readfile(src)
        except Exception:
            doc = None
    if doc is None:
        sys.stderr.write("not DWG bytes and not parseable DXF\n")
        return None, None, None
    return doc, "none", None


def dwg_render_worker(src: str, outdir: str, dpi: int) -> int:
    """`--dwg-render` child entry: get `src` into ezdxf, extract the model-
    space registry, raster the model space, and write `index.json` + a
    `model.png` into `outdir`. Own process (the parser job group-kills it on
    timeout), so a wedged conversion or render dies here, never in the
    parser's server, and its exit frees every matplotlib figure by
    construction.

    Input sniff decides the road in (open_cad): DWG magic -> ezdwg's
    reader (dwg_read.py), a DGN signature -> ezdgn (dgn_read.py), anything
    else -> tried as native DXF (ASCII or binary: ezdxf reads both;
    `recover` mops up malformed files), reported as converter "none". No
    format gate beyond that: a junk upload fails the read and takes the same
    curated exit as a DWG the reader refuses.
    Downstream there is ONE path: ezdxf for both registry and render (its
    drawing add-on expands INSERT blocks; ezdwg's own plot() does not).

    The registry is capped (texts/layers/text length) so the reply stays a
    few MB whatever the drawing holds; the render carries the same measured
    output-pixel guard as the DWF worker. Exits non-zero only when no road
    produces a parseable DXF document."""
    import ezdxf  # noqa: PLC0415 (child-only import; absent on pre-DWG images)

    import matplotlib  # noqa: PLC0415

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt  # noqa: PLC0415
    from ezdxf.addons.drawing import Frontend, RenderContext  # noqa: PLC0415
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend  # noqa: PLC0415
    from ezdxf.addons.drawing.properties import LayoutProperties  # noqa: PLC0415

    import dwg_frame  # noqa: PLC0415 - child-only; sits next to this file

    max_pixels = 30_000_000
    started = time.time()

    doc, converter, notes = open_cad(src, outdir)
    if doc is None:
        return 1

    index = dwg_registry(doc, converter)
    if converter == "ezdgn":
        # What the DGN held that the document does not: counted, never lost.
        index["dgn"] = notes
    elif converter == "ezdwg":
        # The same for a DWG. Its document is made as R2010 in memory, so
        # the version is the one the file was saved in.
        index["dwg"] = notes
        index["version"] = notes.get("version") or index["version"]

    png = os.path.join(outdir, "model.png")

    def render_png(document) -> str | None:
        """Raster `document`'s model space to model.png. Returns None on
        success, the error string on failure (with any partial PNG removed).

        A BLANK output counts as a failure. Nothing here raises when a drawing
        paints nothing (matplotlib saves an empty canvas as happily as a full
        one), so without the ink probe the worker reported success, the app
        stored a white rectangle, and the only clue was its byte size."""
        try:
            msp_layout = document.modelspace()
            # The sheet, not model space: a note parked far off the sheet
            # would otherwise hold the sheet in a corner of the picture, and
            # the same pixels would read far less of it. A drawing with no
            # stray draws exactly as it always did.
            frame = dwg_frame.layout_frame(msp_layout)
            index["frame"] = frame
            framed = frame is not None and frame["framed"]
            # Page shaped to the DRAWING, long edge pinned to the page size.
            # A square page would work (equal aspect centres the drawing in it),
            # but a landscape P&ID would then carry ~35% white margin into
            # every vision call. `bbox.extents(fast=True)` is ~0.6s on a 9.7k
            # entity drawing and uses cached bounding boxes; any failure falls
            # back to the square, which is wasteful but never wrong.
            fig = plt.figure(figsize=cad_page_inches(msp_layout, frame))
            ax = fig.add_axes([0, 0, 1, 1])
            ax.set_axis_off()
            # ACI colour 7 has NO fixed colour: ezdxf resolves it against the
            # layout BACKGROUND, and the default layout is dark, so 7 comes out
            # WHITE: invisible on matplotlib's white page. Overriding the
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
            # stroke weight: ezdxf floors every stroke at a width in POINTS,
            # so a small page makes hairlines ~5× too heavy and fills small
            # text in solid. dpi cannot fix that; only a bigger page can.
            Frontend(
                RenderContext(document), MatplotlibBackend(ax, adjust_figure=False)
            ).draw_layout(msp_layout, finalize=True, layout_properties=lp)
            # The note stays drawn, outside the axes' limits. Saved at the
            # whole page: a tight bbox would measure the note too. The aspect
            # stays equal, so a sheet past the page's clamped shape gains a
            # margin and is never stretched.
            save_opts = SAVEFIG_OPTS
            if framed:
                x0, y0, x1, y1 = frame["sheet"]
                ax.set_xlim(x0, x1)
                ax.set_ylim(y0, y1)
                save_opts = {"facecolor": "white"}
            # The page is fixed, so the output-pixel cap maps straight to a dpi
            # ceiling: clamp BEFORE the first savefig instead of paying an
            # over-budget render only to redo it smaller. Conservative: it
            # assumes the full square page, while the tight bbox below crops to
            # the drawing's own aspect. The measured guard stays as backstop.
            eff_dpi = min(dpi, max(50, int((max_pixels / (RENDER_PAGE_INCHES**2)) ** 0.5)))
            fig.savefig(png, dpi=eff_dpi, **save_opts)
            with open(png, "rb") as f:
                head = f.read(24)
            if head[:8] == b"\x89PNG\r\n\x1a\n":
                pixels = int.from_bytes(head[16:20], "big") * int.from_bytes(head[20:24], "big")
                if pixels > max_pixels:
                    # Nested guard: a failed DOWNSCALE must not delete the good
                    # first render: only a genuinely unusable output is removed.
                    try:
                        fig.savefig(
                            png,
                            dpi=max(50, int(eff_dpi * (max_pixels / pixels) ** 0.5)),
                            **save_opts,
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
            return error_text(err)
        finally:
            plt.close("all")

    # Registry without pixels still ships; the parent tolerates a missing
    # model.png. The reason is recorded so the app side can say WHY the
    # drawing has no image child instead of silently emitting nothing.
    render_error = render_png(doc)

    index["render_error"] = render_error
    # After the picture: the SVGs draw in temporary layouts of the same
    # document, and never cost the registry or model.png.
    index.update(symbols_of(doc, started + SYMBOL_BUDGET_S, started + SYMBOL_STOP_S))

    with open(os.path.join(outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f)
    return 0


class SymbolsStopped(BaseException):
    """The symbols pass ran to SYMBOL_STOP_S. A BaseException, so no
    `except Exception` (a block's draw, inside ezdxf) can swallow it."""


def symbols_of(doc, deadline: float | None = None, stop_at: float | None = None) -> dict:
    """The symbols and placements of a document (dwg_symbols.py), or both
    empty with `symbols_error` when the pass fails: the key is always there,
    so a reply with no `symbols` is an image before this pass. At `stop_at`
    (a time.time() value) a timer stops the pass wherever it is, and again
    every second until it has (a bare `except:` inside ezdxf can swallow one
    stop): one bound on its time, whatever a hostile drawing holds."""
    import signal  # noqa: PLC0415

    import dwg_bones  # noqa: PLC0415 - child-only; sits next to this file
    import dwg_symbols  # noqa: PLC0415 - child-only; sits next to this file

    def failed(why: str) -> dict:
        return {
            "symbols": [],
            "placements": [],
            "placements_capped": False,
            "symbol_facts": None,
            "symbols_error": why,
        }

    if stop_at is not None and stop_at <= time.time():
        return failed(f"no time was left for the symbols pass ({SYMBOL_STOP_S} s)")
    # Only while the pass runs: a tick that lands as it ends does nothing,
    # so a stop never escapes past the worker's index.json.
    armed = [True]

    def stop(_signum, _frame):
        if armed[0]:
            raise SymbolsStopped(f"the symbols pass ran past {SYMBOL_STOP_S} s and was stopped")

    before = signal.signal(signal.SIGALRM, stop)
    try:
        try:
            # Inside the try its finally clears: a stop that lands at once
            # is cleared too. Never 0, which would turn the timer off.
            if stop_at is not None:
                signal.setitimer(signal.ITIMER_REAL, max(0.001, stop_at - time.time()), 1.0)
            out = dwg_symbols.symbols_index(doc, dwg_bones.coord, deadline)
        finally:
            armed[0] = False
            signal.setitimer(signal.ITIMER_REAL, 0)
        out["symbols_error"] = None
        return out
    except (Exception, SymbolsStopped) as err:
        return failed(error_text(err))
    finally:
        signal.signal(signal.SIGALRM, before)


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
        sys.stderr.write(f"crop spec: {error_text(err, 300) if isinstance(err, OSError) else scrub_paths(str(err))}\n")
        return 1
    started = time.time()
    doc, converter, _notes = open_cad(src, outdir)
    if doc is None:
        return 1
    try:
        index = dwg_crop.render(doc, spec, outdir, deadline=started + CROP_BUDGET_S)
    except dwg_crop.SpecError as err:
        sys.stderr.write(f"crop spec: {err}\n")
        return 1
    except Exception as err:
        # Stderr is the job's answer: the reason, never a traceback's paths.
        sys.stderr.write(f"the crops could not be drawn: {error_text(err, 270)}\n")
        return 1
    index["converter"] = converter
    for crop in index["crops"]:
        if crop.get("view"):
            # A window with nothing in it is an answer: the caller moves it.
            crop["blank"] = png_has_no_ink(os.path.join(outdir, crop["file"]))
    with open(os.path.join(outdir, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, allow_nan=False)
    return 0


def _size_value(value, digits: int):
    """A size for the reply: a finite number, else None."""
    import dwg_bones  # noqa: PLC0415 - child-only; sits next to this file

    return dwg_bones.coord(value, digits)


# How a redraw sets a text (drawing_redraw): the point on the baseline of its
# first line, in world units, the side of that point the text runs to, and
# its turn. A CAD text names one of 15 justifications (an MTEXT one of 9
# attachment points); the browser's font is not the drawing's, so only the
# justification point is true for both, and a text set from its left end
# would drift by the difference in width.
LINE_GAP = 5.0 / 3.0  # an MTEXT's line pitch, in text heights (factor 1)
DESCENT = 1.0 / 3.0  # a font's descender depth, in text heights
_SWAP = {"left": "right", "center": "center", "right": "left"}
_UNICODE_CODE = re.compile(r"\\U\+([0-9A-Fa-f]{4})")
_TEXT_CODE = re.compile(r"%%(\d{3}|\d{1,2}(?!\d)|[uUoOkKdDcCpP%])")
_TEXT_CHARS = {"d": "\u00b0", "c": "\u00d8", "p": "\u00b1", "%": "%"}


def plain_line(raw) -> str:
    """A text as it reads: %%d, %%c and %%p as the degree, diameter and
    plus-minus signs, %%nnn (one to three digits: %%94 is a caret) and a
    \\U+XXXX escape as that character (never a control character), and the underline, overline and strike switches
    (%%u, %%o, %%k) gone. Nothing else changes: a caret stays a caret (only
    a DXF file writes a control character with one, and ezdxf's own
    plain_text would turn `X^2` into another text). Run once on a text."""

    def char(m) -> str:
        code = m.group(1)
        if code.isdigit():
            return chr(int(code)) if int(code) >= 32 else ""
        return _TEXT_CHARS.get(code.lower(), "")

    def escape(m) -> str:
        point = int(m.group(1), 16)
        return chr(point) if point >= 32 else ""

    return _UNICODE_CODE.sub(escape, _TEXT_CODE.sub(char, str(raw)))


def _baseline_point(point, turn: float, down: float):
    """`point` moved `down` below itself, for a text turned `turn` degrees."""
    a = math.radians(turn)
    return (point[0] + math.sin(a) * down, point[1] - math.cos(a) * down)


def line_layout(entity) -> dict:
    """A TEXT's or an ATTRIB's layout: x, y (its insert in world units), ax,
    ay, align and rotation (degrees counter-clockwise, 0 to 360, as it
    reads). A mirrored text (its normal points down) reads the other way:
    the turn and the side are those of the text as a person reads it. A FIT
    or ALIGNED text is set from the middle of its two points."""
    from ezdxf.math import Vec3  # noqa: PLC0415 - child-only

    d = entity.dxf
    height = float(d.get("height", 0.0) or 0.0)
    ocs = entity.ocs()
    flipped = ocs.uz.z < 0
    insert = ocs.to_wcs(Vec3(d.insert))
    align, p1, p2 = entity.get_placement()
    name = align.name
    if name in ("FIT", "ALIGNED") and p2 is not None and Vec3(p1).distance(Vec3(p2)) > 1e-9:
        a, b = ocs.to_wcs(Vec3(p1)), ocs.to_wcs(Vec3(p2))
        if flipped:
            a, b = b, a
        turn = math.degrees(math.atan2(b.y - a.y, b.x - a.x))
        point, side = ((a.x + b.x) / 2, (a.y + b.y) / 2), "center"
    else:
        along = ocs.to_wcs(Vec3.from_deg_angle(float(d.get("rotation", 0.0) or 0.0)))
        turn = math.degrees(math.atan2(along.y, along.x)) + (180.0 if flipped else 0.0)
        # LEFT, CENTER, RIGHT: on the baseline. MIDDLE: the middle of the
        # text. BOTTOM_x, MIDDLE_x, TOP_x: that row.
        row, _, side = name.rpartition("_")
        if side == "MIDDLE":
            row, side = "MIDDLE", "CENTER"
        if side not in ("LEFT", "CENTER", "RIGHT"):  # FIT with one point
            side = "LEFT"
        down = {"BOTTOM": -height * DESCENT, "MIDDLE": height / 2, "TOP": height}.get(row, 0.0)
        at = ocs.to_wcs(Vec3(p1))
        point = _baseline_point((at.x, at.y), turn, down)
        side = side.lower()
        if flipped:
            side = _SWAP[side]
    return {"x": insert.x, "y": insert.y, "ax": point[0], "ay": point[1], "align": side, "rotation": turn}


def wrap_lines(paragraphs, width: float, measure) -> list:
    """An MTEXT's lines: its paragraphs, each cut at its spaces to the box
    width (0: no wrap), by `measure` (a text's length). Empty lines at the
    end are dropped; one in the middle stays (a gap)."""
    lines: list = []
    for p in paragraphs:
        p = " ".join(str(p).split())
        if not (width > 0 and measure(p) > width):
            lines.append(p)
            continue
        line = ""
        for word in p.split(" "):
            longer = f"{line} {word}" if line else word
            if line and measure(longer) > width:
                lines.append(line)
                line = word
            else:
                line = longer
        lines.append(line)
    while lines and not lines[-1]:
        lines.pop()
    return lines


def block_layout(insert, attachment: int, height: float, turn: float, lines: int, factor: float, flipped: bool) -> dict:
    """An MTEXT's layout from its attachment point (1 to 9: top left to
    bottom right): the keys of line_layout, and gap (from one baseline to
    the next, when it has more than one line). `lines` is how many lines it
    has; `factor` its line spacing factor."""
    side = ("left", "center", "right")[(attachment - 1) % 3]
    row = (attachment - 1) // 3
    gap = height * LINE_GAP * factor
    block = height + (max(lines, 1) - 1) * gap
    # The first baseline below the attachment point: a text height under
    # the top; from the middle or the bottom, counted up by the block.
    down = (height, height - block / 2, height - block)[row]
    if flipped:
        turn, side = turn + 180.0, _SWAP[side]
    ax, ay = _baseline_point((insert[0], insert[1]), turn, down)
    return {
        "x": insert[0],
        "y": insert[1],
        "ax": ax,
        "ay": ay,
        "align": side,
        "rotation": turn,
        "gap": gap if lines > 1 else None,
    }


def text_layout(entity, mtext: bool, doc=None):
    """What the registry keeps of a TEXT, ATTRIB or MTEXT: (text, layout).
    `text` is the entity's text (an MTEXT's format codes gone; add_value
    reads its %% codes). `layout` holds x, y, height (None when not above 0),
    rotation, width (an MTEXT's box width, 0 for no wrap; None for a TEXT or
    an ATTRIB), ax, ay, align, lines (an MTEXT of more than one line: its
    lines, joined by a newline), gap (from one such line to the next) and
    underline. Best effort: a layout that
    cannot be read is None, and the text still counts."""
    try:
        paragraphs = entity.plain_text(split=True) if mtext else [entity.dxf.text]
    except Exception:
        paragraphs = [entity.text if mtext else entity.dxf.text]
    text = " ".join(str(p) for p in paragraphs)
    try:
        d = entity.dxf
        height = float(d.get("char_height" if mtext else "height", 0.0) or 0.0)
        if not mtext:
            lay = line_layout(entity)
            lay.update(width=None, lines=None, underline="%%u" in str(d.text).lower())
        else:
            from ezdxf.fonts import fonts  # noqa: PLC0415 - child-only

            width = float(d.get("width", 0.0) or 0.0)
            try:
                # The style's font measures a line for the wrap; a style the
                # file does not hold, or no font at all: no wrap.
                name = d.get("style", "Standard")
                style = doc.styles.get(name) if doc is not None and name in doc.styles else None
                font = (style.dxf.get("font", "") if style else "") or "txt"
                measure, wrap_at = fonts.make_font(font, height or 1.0, 1.0).text_width, width
            except Exception:
                measure, wrap_at = len, 0.0
            lines = wrap_lines(paragraphs, wrap_at, measure)
            flipped = entity.ocs().uz.z < 0
            turn = float(entity.get_rotation())
            if flipped and not d.hasattr("text_direction"):
                turn = 180.0 - turn  # the angle is in the mirrored plane
            lay = block_layout(
                d.insert,
                int(d.get("attachment_point", 1) or 1),
                height,
                turn,
                len(lines),
                float(d.get("line_spacing_factor", 1.0) or 1.0),
                flipped,
            )
            lay.update(width=width, lines="\n".join(lines) if len(lines) > 1 else None, underline=False)
        lay["height"] = height
        return text, lay
    except Exception:
        return text, None


# The drawable model-space line work (drawing_redraw draws it): each LINE,
# CIRCLE, ARC, ELLIPSE, SPLINE and polyline as one SVG path in drawing units,
# y up, with its box. Segments is the pipe network: it keeps a bulge or an ARC
# as its chord, leaves out circles, ellipses, splines and small closed
# polylines, and holds nothing when the network pass gives up on a large
# drawing; a redraw reads this instead. A SOLID and a TRACE (an arrow head, a
# filled bar) are here as their outline, which a redraw fills, and a LEADER
# as the line through its points (its arrow head is no entity: not drawn).
# None of the three is a segment: the pipe network does not read them.
SHAPE_TYPES = ("LINE", "CIRCLE", "ARC", "ELLIPSE", "SPLINE", "LWPOLYLINE", "POLYLINE", "SOLID", "TRACE", "LEADER")
MAX_SHAPES = 100_000
MAX_SHAPE_PATH = 50_000  # characters of one path: a longer one is left out, counted
MAX_SHAPE_CHARS = 8_000_000  # characters of every path of a file


class ShapeTooLong(Exception):
    """A path past MAX_SHAPE_PATH characters."""


def _path_number(v: float) -> str:
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-", "-0") else s


def shape_record(e, etype: str, layer: str):
    """One drawable entity as {kind, layer, handle, path, minx, miny, maxx,
    maxy}, or None (a mesh, an empty or non-finite path). The path is exact:
    ezdxf's path of the entity in WCS (arcs and splines as Bezier curves),
    written as SVG M, L, Q and C commands; the box is the box of its control
    points, which holds the curve."""
    from ezdxf import path as ezpath  # noqa: PLC0415 - child-only, heavy

    if etype == "LINE":
        a, b = e.dxf.start, e.dxf.end
        vals = [float(a.x), float(a.y), float(b.x), float(b.y)]
        if not all(math.isfinite(v) for v in vals):
            return None
        n = _path_number
        return {
            "kind": etype,
            "layer": layer,
            "handle": str(getattr(e.dxf, "handle", "") or ""),
            "path": f"M{n(vals[0])} {n(vals[1])}L{n(vals[2])} {n(vals[3])}",
            "minx": min(vals[0], vals[2]),
            "miny": min(vals[1], vals[3]),
            "maxx": max(vals[0], vals[2]),
            "maxy": max(vals[1], vals[3]),
        }
    if etype == "POLYLINE" and (e.is_poly_face_mesh or e.is_polygon_mesh):
        return None
    frame = etype == "POLYLINE" and any(v.dxf.flags & 16 for v in e.vertices)
    if etype == "LEADER":
        # Its points are in WCS; a splined leader is drawn as its points.
        p = ezpath.from_vertices(e.vertices)
    elif frame:
        # A splined POLYLINE: its spline frame's control points are not on
        # the curve (dwg_bones drops them too); the fit points are.
        pts = [v.dxf.location for v in e.vertices if not v.dxf.flags & 16]
        if e.is_2d_polyline:
            pts = list(e.ocs().points_to_wcs(pts))
        p = ezpath.from_vertices(pts, close=e.is_closed)
    else:
        p = ezpath.make_path(e)
    if not len(p):
        return None
    pts = [p.start]
    out = []
    n = _path_number
    out.append(f"M{n(p.start.x)} {n(p.start.y)}")
    kinds = ezpath.Command
    size = 0
    for c in p.commands():
        # Stop as soon as the path is past its cap: a polyline of millions
        # of vertices is never written out whole.
        size += len(out[-1])
        if size > MAX_SHAPE_PATH:
            raise ShapeTooLong()
        if c.type == kinds.LINE_TO:
            out.append(f"L{n(c.end.x)} {n(c.end.y)}")
            pts.append(c.end)
        elif c.type == kinds.CURVE3_TO:
            out.append(f"Q{n(c.ctrl.x)} {n(c.ctrl.y)} {n(c.end.x)} {n(c.end.y)}")
            pts.extend((c.ctrl, c.end))
        elif c.type == kinds.CURVE4_TO:
            out.append(
                f"C{n(c.ctrl1.x)} {n(c.ctrl1.y)} {n(c.ctrl2.x)} {n(c.ctrl2.y)}"
                f" {n(c.end.x)} {n(c.end.y)}"
            )
            pts.extend((c.ctrl1, c.ctrl2, c.end))
        elif c.type == kinds.MOVE_TO:
            out.append(f"M{n(c.end.x)} {n(c.end.y)}")
            pts.append(c.end)
    xs = [float(q.x) for q in pts]
    ys = [float(q.y) for q in pts]
    if not all(math.isfinite(v) for v in xs + ys):
        return None
    return {
        "kind": etype,
        "layer": layer,
        "handle": str(getattr(e.dxf, "handle", "") or ""),
        "path": "".join(out),
        "minx": min(xs),
        "miny": min(ys),
        "maxx": max(xs),
        "maxy": max(ys),
    }


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
    # A DGN's hidden values (item data and tags, dgn_read.py) come after its
    # drawn texts, so they can never push a drawn text past the cap. Only
    # for a DGN: a DWG's or DXF's registry stays what it always was.
    hidden_last = converter == "ezdgn"
    hidden: list = []

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

    shapes: list = []
    shape_chars = 0
    shapes_capped = False
    shapes_left_out: dict = {}

    def add_shape(e, etype: str, layer: str) -> None:
        """One drawable entity into `shapes`, under its caps; a failure is
        counted with the other unreadable entities, never fatal."""
        nonlocal shape_chars, shapes_capped
        if shapes_capped:
            return
        try:
            rec = shape_record(e, etype, layer)
        except ShapeTooLong:
            shapes_left_out["too long"] = shapes_left_out.get("too long", 0) + 1
            return
        except Exception:
            shapes_left_out["unreadable"] = shapes_left_out.get("unreadable", 0) + 1
            return
        if rec is None:
            return
        size = len(rec["path"])
        if size > MAX_SHAPE_PATH:
            shapes_left_out["too long"] = shapes_left_out.get("too long", 0) + 1
            return
        if len(shapes) >= MAX_SHAPES or shape_chars + size > MAX_SHAPE_CHARS:
            shapes_capped = True
            return
        shape_chars += size
        shapes.append(rec)

    def add_text(entity, layer: str, block: str = "") -> None:
        """Harvest one text-bearing entity into `texts` under the shared caps.
        `block`: the handle of the INSERT an ATTRIB belongs to."""
        mtext = entity.dxftype() == "MTEXT"
        hide = hidden_last and (
            getattr(entity, "is_invisible", False) or entity.dxf.get("invisible", 0) == 1
        )
        raw, layout = text_layout(entity, mtext, doc)
        if layout is None and hasattr(entity.dxf, "insert"):
            layout = {"x": entity.dxf.insert[0], "y": entity.dxf.insert[1]}
        add_value(raw, layer, layout, hide, block)

    def add_value(raw, layer: str, layout, hide: bool = False, block: str = "") -> None:
        nonlocal texts_capped
        text = " ".join(plain_line(raw).split())[:max_text_len]
        if not text:
            return
        into = hidden if hide else texts
        if len(into) >= max_texts:
            texts_capped = True
            return
        lay = layout or {}
        height = _size_value(lay.get("height"), 4)
        rotation = _size_value(lay.get("rotation"), 2)
        lines = lay.get("lines")
        into.append(
            {
                "text": text,
                "layer": layer,
                "x": coord(lay.get("x")),
                "y": coord(lay.get("y")),
                # The size and turn a redraw sets the text in (drawing_redraw):
                # the height in drawing units, the turn in degrees counter-
                # clockwise as the text reads, and an MTEXT's box width (0: no
                # wrap; None for a one-line text).
                "height": height if height is not None and height > 0 else None,
                "rotation": (rotation % 360.0) + 0.0 if rotation is not None else None,
                "width": _size_value(lay.get("width"), 4) if lay.get("width") is not None else None,
                # Where a redraw sets it from: the point on its first line's
                # baseline (4 decimals: a text is small in a drawing in
                # metres), the side the text runs to from there, its lines
                # when it has more than one with the gap from one baseline to
                # the next, and whether it is underlined.
                "ax": _size_value(lay.get("ax"), 4),
                "ay": _size_value(lay.get("ay"), 4),
                "align": lay.get("align"),
                "lines": plain_line(lines)[:max_text_len] if isinstance(lines, str) and lines else None,
                "gap": _size_value(lay.get("gap"), 4) if lines else None,
                "underline": bool(lay.get("underline")),
            }
        )
        if block:
            # An attribute goes with its block: a redraw that switches the
            # sheet's border block off switches its title texts off with it.
            into[-1]["block"] = block

    for e in msp:
        entities += 1
        etype = e.dxftype()
        type_counts[etype] = type_counts.get(etype, 0) + 1
        layer = str(getattr(e.dxf, "layer", "") or "")
        layer_counts[layer] = layer_counts.get(layer, 0) + 1
        gather(e, etype, layer)
        if etype in SHAPE_TYPES:
            add_shape(e, etype, layer)
        if etype in ("TEXT", "MTEXT"):
            try:
                add_text(e, layer)
            except Exception:
                continue
        elif etype == "MULTILEADER":
            # A leader's label: its text, or a block label's attribute
            # texts. A DXF holds the attribute texts only in the entity, so
            # a TEXT/MTEXT sweep alone never reads them.
            try:
                ctx = e.context
                if ctx.mtext is not None:
                    from ezdxf.tools.text import plain_mtext  # noqa: PLC0415

                    content = plain_mtext(ctx.mtext.default_content, split=True)
                    layout = {"x": ctx.mtext.insert[0], "y": ctx.mtext.insert[1]}
                    try:
                        # A leader's text hangs from the top of its first
                        # line, on the side its alignment names (1 to 3).
                        lines = wrap_lines(content, 0.0, len)
                        layout = block_layout(
                            ctx.mtext.insert,
                            min(max(int(ctx.mtext.alignment or 1), 1), 3),
                            float(ctx.char_height),
                            math.degrees(ctx.mtext.rotation),
                            len(lines),
                            float(ctx.mtext.line_spacing_factor or 1.0),
                            False,
                        )
                        layout.update(
                            height=float(ctx.char_height),
                            width=ctx.mtext.width,
                            lines="\n".join(lines) if len(lines) > 1 else None,
                        )
                    except Exception:
                        pass
                    add_value(" ".join(content), layer, layout)
                for attrib in e.block_attribs:
                    at = ctx.block.insert if ctx.block is not None else None
                    add_value(attrib.text, layer, {"x": at[0], "y": at[1]} if at is not None else None)
            except Exception:
                continue
        elif etype == "INSERT":
            # Block ATTRIBs carry the real content on attribute-driven
            # drawings (title blocks, circuit/line-number tags): a top-level
            # TEXT/MTEXT sweep alone misses hundreds of values per file.
            # Each attrib also lands in `blocks` keyed by its TAG, one record
            # per INSERT: on circuitized P&IDs a LineNumber block holds
            # LINENO and CIRCUIT side by side, and the flat Texts list loses
            # that pairing (found on a client brain 2026-10-23).
            attribs: dict = {}
            owner = str(getattr(e.dxf, "handle", "") or "")
            for attrib in getattr(e, "attribs", None) or []:
                try:
                    type_counts["ATTRIB"] = type_counts.get("ATTRIB", 0) + 1
                    add_text(attrib, str(getattr(attrib.dxf, "layer", "") or ""), owner)
                    tag = str(getattr(attrib.dxf, "tag", "") or "").strip()
                    value = " ".join(plain_line(attrib.dxf.text or "").split())[:max_text_len]
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

    room = max_texts - len(texts)
    if len(hidden) > room:
        texts_capped = True
    texts.extend(hidden[:room])
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
        "shapes": shapes,
        "shapes_capped": shapes_capped,
        "shapes_left_out": shapes_left_out,
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
            geometry_error = scrub_paths(str(err))[:500]
        except Exception as err:
            geometry_error = error_text(err)
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
