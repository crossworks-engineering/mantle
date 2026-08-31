#!/usr/bin/env python3
"""Media sidecar: yt-dlp + ffmpeg behind a narrow HTTP interface.

The one container in the stack allowed to run a fast-moving, auto-updating,
network-facing binary that parses hostile input from the open web. Its safety
model is ISOLATION plus its own egress guard: no database, no secrets, no
file-store mounts, and every URL's resolved addresses are checked against the
private/link-local ranges before yt-dlp runs (the app checks too, but the
sidecar is the process actually fetching — a redirect must not reach
loopback/RFC1918/metadata from HERE).

Synchronous by design. The calling tool blocks its turn anyway, so a job/poll
API would buy nothing and cost job state, cleanup, and a polling loop.
Long-op protection is layered timeouts: every subprocess runs in its own
process GROUP with a hard timeout (the group kill covers yt-dlp's ffmpeg
grandchildren), the socket has its own timeout, and the app-side client runs
an AbortController backstop on top.

Wire notes that bit us once already (keep them true):
  - Header values are single-line ASCII: the title is percent-encoded
    (URI-style), numbers go out as plain digits. email.header folding is
    banned — folded headers are invalid HTTP/1.1 and undici rejects the
    whole response.
  - Every error response closes the connection (Connection: close). We often
    error WITHOUT reading the request body; on a keep-alive socket the
    unread body would be parsed as the next request.

Routes (bearer auth on everything except /healthz):
  GET  /healthz                        -> {ok, versions:{yt_dlp, ffmpeg, ezdwf}}
  POST /probe          {url}           -> metadata + caption availability
  POST /captions       {url,lang?,prefer?} -> {content: "<vtt>", source, lang}
  POST /audio          {url,maxDurationSeconds?,maxBytes?} -> mp3 bytes
  POST /extract-audio  <raw video bytes>   -> mp3 bytes
  POST /video          {url,maxBytes?}     -> mp4 bytes
  POST /dwf/render     <raw DWF bytes> (X-Dwf-Dpi?) -> {sheets:[{name,width,
                       height,png_base64}], truncated} — per-sheet rasters of
                       an Autodesk DWF plot set, rendered by ezdwf (MIT; the
                       CAD-visual half of this sidecar's single purpose:
                       extracting viewable media from formats the app process
                       shouldn't parse itself)

Error envelope on every non-2xx: {"ok":false,"error":{"code","message"}}.
Codes: unauthorized, bad_request, blocked_url, no_captions,
extraction_failed, duration_exceeded, size_exceeded, timeout, busy.
"""

import base64
import ipaddress
import json
import hmac
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, urlsplit

PORT = int(os.environ.get("MEDIA_PORT", "8095"))
TOKEN = os.environ.get("MEDIA_TOKEN", "")
MAX_CONCURRENT = int(os.environ.get("MEDIA_MAX_CONCURRENT", "2"))
# Probe/captions are cheap-ish but still spawn yt-dlp + hit the network, so
# they get their own (larger) bound instead of none.
MAX_LIGHT_CONCURRENT = int(os.environ.get("MEDIA_MAX_LIGHT_CONCURRENT", "4"))
# /extract-audio request-body cap. Enforced WHILE reading, not after.
MAX_UPLOAD_BYTES = int(os.environ.get("MEDIA_MAX_UPLOAD_BYTES", str(1024**3)))

# Per-operation subprocess timeouts (seconds). Fixed, not env: they encode
# what each operation is allowed to cost, and the app-side client mirrors
# them with a +30s backstop.
TIMEOUT_PROBE = 60
TIMEOUT_CAPTIONS = 120
TIMEOUT_AUDIO = 900
TIMEOUT_EXTRACT = 600
TIMEOUT_VIDEO = 1500

JSON_BODY_CAP = 64 * 1024  # JSON endpoints only; /extract-audio streams.
# Optional operator-supplied cookies (YouTube's datacenter-IP bot check).
# THE one exception to "this container holds nothing": a scoped, operator-
# owned browser-session export, mounted READ-ONLY, never a brain secret.
# Absent file = feature off; see docs/video-ingest.md for the trade-offs.
COOKIES_FILE = os.environ.get("MEDIA_COOKIES_FILE", "/etc/media/cookies.txt")
STDERR_TAIL = 2048  # extraction_failed carries at most this much stderr.
CAPTIONS_CAP = 5 * 1024 * 1024  # a VTT bigger than this is not a transcript.

# Orphan reaping (a group-killed yt-dlp's ffmpeg reparents to PID 1) is the
# init process's job, NOT ours: compose runs this container with `init: true`
# so tini is PID 1 and reaps. Never SIG_IGN SIGCHLD here — auto-reap steals
# subprocess's waitpid and every child's returncode reads 0, which would
# silently convert yt-dlp failures into 'success with no output'.

# Heavy ops (a download or a transcode) hold a slot; full -> immediate 429 so
# the caller can say "retry shortly" instead of queueing invisible work.
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
_light_slots = threading.BoundedSemaphore(MAX_LIGHT_CONCURRENT)

# /healthz is polled by the compose healthcheck; hold the lock ACROSS the
# refresh so N concurrent cold polls spawn one probe pair, not N.
_versions_cache: dict = {"at": 0.0, "value": None}
_versions_lock = threading.Lock()


def get_versions() -> dict:
    with _versions_lock:
        if _versions_cache["value"] is not None and time.time() - _versions_cache["at"] < 300:
            return _versions_cache["value"]
        ytdlp = ffmpeg = None
        try:
            ytdlp = (
                subprocess.run(
                    ["yt-dlp", "--version"], capture_output=True, text=True, timeout=20
                ).stdout.strip()
                or None
            )
        except Exception:
            pass
        try:
            first = subprocess.run(
                ["ffmpeg", "-version"], capture_output=True, text=True, timeout=20
            ).stdout.splitlines()
            # "ffmpeg version 6.1.1-3ubuntu5 ..." -> "6.1.1-3ubuntu5"
            ffmpeg = first[0].split()[2] if first and len(first[0].split()) > 2 else None
        except Exception:
            pass
        ezdwf_version = None
        try:
            import ezdwf  # noqa: PLC0415 — optional; absent on images built before the CAD tier

            ezdwf_version = getattr(ezdwf, "__version__", "unknown")
        except Exception:
            pass
        value = {"yt_dlp": ytdlp, "ffmpeg": ffmpeg, "ezdwf": ezdwf_version}
        _versions_cache.update(at=time.time(), value=value)
        return value


class OpError(Exception):
    """A failure with a wire shape: HTTP status + error code + message."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def int_field(value, dflt: int, lo: int, hi: int, name: str) -> int:
    """Bounded int parse -> 400 bad_request, never a 500. `None` (absent)
    takes the default; an explicit 0 is OUT OF RANGE, not 'use default'."""
    if value is None:
        return dflt
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise OpError(400, "bad_request", f"'{name}' must be an integer (got {value!r})")
    if not (lo <= n <= hi):
        raise OpError(400, "bad_request", f"'{name}' must be between {lo} and {hi} (got {n})")
    return n


# ─── egress guard ───────────────────────────────────────────────────────────
# The app SSRF-checks the URL string before we see it, but WE are the process
# that fetches — and a public URL can redirect anywhere. This re-check of the
# initial host's resolved addresses closes the front door from inside the
# container; redirects to private space remain a residual (yt-dlp follows
# them internally) which is why this container also holds nothing worth
# stealing. Fail closed on resolution errors.


def _is_blocked_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
        or (addr.version == 4 and addr in ipaddress.ip_network("100.64.0.0/10"))
    )


def assert_public_host(url: str) -> None:
    host = urlsplit(url).hostname
    if not host:
        raise OpError(400, "bad_request", "URL has no host")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as err:
        raise OpError(400, "blocked_url", f"could not resolve '{host}': {err}")
    for info in infos:
        ip = info[4][0]
        if _is_blocked_ip(ip):
            raise OpError(
                400,
                "blocked_url",
                f"'{host}' resolves to a private/reserved address ({ip}); refusing to fetch",
            )


# ─── subprocess plumbing ────────────────────────────────────────────────────


def run(cmd: list, timeout: int, cwd: str | None = None) -> subprocess.CompletedProcess:
    """Run a subprocess in its OWN PROCESS GROUP with a hard timeout. On
    timeout the whole group is killed — yt-dlp's ffmpeg grandchildren
    included, so a cancelled job can't keep burning CPU into a tempdir that
    is about to be rmtree'd."""
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=cwd,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        proc.wait()
        raise OpError(504, "timeout", f"{cmd[0]} exceeded {timeout}s and was killed")
    if proc.returncode != 0:
        tail = (stderr or "")[-STDERR_TAIL:]
        raise OpError(
            502,
            "extraction_failed",
            f"{cmd[0]} exited {proc.returncode}. yt-dlp self-updates daily; if this is a "
            f"site change, retry later. stderr tail:\n{tail}",
        )
    return subprocess.CompletedProcess(cmd, proc.returncode, stdout, stderr)


def cookie_args(tmp: str) -> list:
    """yt-dlp writes rotated cookies BACK to the file it is handed, so give it
    a per-run working copy inside the op's tempdir — the mount stays
    read-only and concurrent jobs can't clobber each other. Rotations are
    therefore not persisted: the exported file goes stale on YouTube's own
    schedule and the operator re-exports (docs/video-ingest.md)."""
    try:
        if not os.path.isfile(COOKIES_FILE) or os.path.getsize(COOKIES_FILE) == 0:
            return []
        work = os.path.join(tmp, "cookies.txt")
        shutil.copyfile(COOKIES_FILE, work)
        return ["--cookies", work]
    except OSError:
        return []


def cookies_present() -> bool:
    try:
        return os.path.isfile(COOKIES_FILE) and os.path.getsize(COOKIES_FILE) > 0
    except OSError:
        return False


def ytdlp_probe(url: str) -> dict:
    """`yt-dlp -J` metadata. The one call every URL operation starts with."""
    with tempfile.TemporaryDirectory() as tmp:
        proc = run(
            ["yt-dlp", *cookie_args(tmp), "-J", "--no-download", "--no-playlist", "--no-warnings", url],
            TIMEOUT_PROBE,
        )
    try:
        info = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise OpError(502, "extraction_failed", "yt-dlp returned unparseable metadata")
    return info


def reject_unbounded(info: dict) -> None:
    """A live stream (or anything without a known duration) has no end; a
    'download' of it runs until the op timeout while holding a heavy slot.
    Refuse up front with an honest reason."""
    if info.get("is_live"):
        raise OpError(400, "bad_request", "this is a LIVE stream — there is nothing bounded to download")
    if not isinstance(info.get("duration"), (int, float)):
        raise OpError(
            400,
            "bad_request",
            "the video reports no duration (live/unbounded content); refusing to download",
        )


def probe_summary(info: dict) -> dict:
    return {
        "title": info.get("title"),
        "durationSeconds": info.get("duration"),
        "channel": info.get("channel") or info.get("uploader"),
        "uploadDate": info.get("upload_date"),
        "extractor": info.get("extractor"),
        "isLive": bool(info.get("is_live")),
        "captions": {
            "manual": sorted((info.get("subtitles") or {}).keys()),
            "auto": sorted((info.get("automatic_captions") or {}).keys()),
        },
        "filesizeApprox": info.get("filesize_approx"),
    }


def fetch_captions(url: str, lang: str | None, prefer: str, tmp: str) -> dict:
    """Download one caption track as VTT. Manual outranks auto for 'any', and
    a FAILED manual attempt falls through to auto instead of erroring — the
    caller asked for 'any', so any is what they get."""
    info = ytdlp_probe(url)
    manual = (info.get("subtitles") or {}).keys()
    auto = (info.get("automatic_captions") or {}).keys()

    def pick(langs) -> str | None:
        if not langs:
            return None
        if lang:
            # Exact first, then variants (en matches en-US / en-orig).
            for cand in langs:
                if cand == lang:
                    return cand
            for cand in sorted(langs):
                if cand.startswith(lang + "-") or cand.startswith(lang + "."):
                    return cand
            return None
        for cand in ("en", "en-US", "en-orig"):
            if cand in langs:
                return cand
        return sorted(langs)[0]

    attempts = []
    if prefer in ("manual", "any"):
        picked = pick(manual)
        if picked:
            attempts.append(("manual", "--write-subs", picked))
    if prefer in ("auto", "any"):
        picked = pick(auto)
        if picked:
            attempts.append(("auto", "--write-auto-subs", picked))
    if not attempts:
        raise OpError(404, "no_captions", "no caption track matches the request")

    last_err: OpError | None = None
    for source, flag, track in attempts:
        sub_tmp = tempfile.mkdtemp(dir=tmp)
        try:
            run(
                [
                    "yt-dlp",
                    *cookie_args(sub_tmp),
                    "--skip-download",
                    "--no-playlist",
                    "--no-warnings",
                    flag,
                    "--sub-langs",
                    track,
                    "--sub-format",
                    "vtt",
                    "-o",
                    os.path.join(sub_tmp, "sub"),
                    url,
                ],
                TIMEOUT_CAPTIONS,
                cwd=sub_tmp,
            )
        except OpError as err:
            last_err = err
            continue
        vtts = [f for f in os.listdir(sub_tmp) if f.endswith(".vtt")]
        if vtts:
            path = os.path.join(sub_tmp, vtts[0])
            if os.path.getsize(path) > CAPTIONS_CAP:
                raise OpError(413, "size_exceeded", "caption track exceeds 5 MB")
            with open(path, encoding="utf-8", errors="replace") as f:
                return {
                    "ok": True,
                    "source": source,
                    "lang": track,
                    "format": "vtt",
                    "content": f.read(),
                }
    if last_err is not None:
        raise last_err
    raise OpError(404, "no_captions", "caption track advertised but not downloadable")


def transcode_to_mp3(src: str, tmp: str, timeout: int) -> str:
    """Speech-grade mono mp3 — the smallest thing every STT adapter accepts."""
    out = os.path.join(tmp, "out.mp3")
    run(["ffmpeg", "-y", "-i", src, "-vn", "-ac", "1", "-b:a", "32k", "-f", "mp3", out], timeout)
    return out


def ffprobe_duration(path: str) -> float | None:
    try:
        proc = run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            60,
        )
        return float(proc.stdout.strip())
    except (OpError, ValueError):
        return None


def header_safe(v) -> str | None:
    """One single-line ASCII token per header value, or the response is not
    HTTP. Numbers pass through as digits; text is percent-encoded (client
    decodeURIComponent's it). Lone surrogates from a hostile page's title are
    scrubbed BEFORE encoding so building the header can never raise
    mid-response."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return str(v)
    clean = str(v).encode("utf-8", "replace").decode("utf-8")
    return quote(clean, safe="")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Socket-level bound on EVERY blocking read/write. A client that stops
    # reading mid-stream would otherwise hold a heavy slot forever.
    timeout = 120

    def log_message(self, fmt, *args):  # noqa: N802
        sys.stderr.write("[media] %s %s\n" % (self.address_string(), fmt % args))

    # ── plumbing ────────────────────────────────────────────────────────────
    def setup(self):
        super().setup()
        # True once any response bytes may have been written; a late error
        # must then close the socket, never start a second response.
        self._responded = False

    def _authed(self) -> bool:
        header = self.headers.get("Authorization", "")
        expected = "Bearer " + TOKEN
        return bool(TOKEN) and hmac.compare_digest(header.encode(), expected.encode())

    def _send_json(self, status: int, obj: dict, close: bool = False):
        body = json.dumps(obj).encode()
        self._responded = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if close:
            # Errors often fire WITHOUT reading the request body; on
            # keep-alive the unread body would be parsed as the next request.
            # Closing is the simple, always-correct answer.
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(body)

    def _send_error_env(self, err: OpError):
        if self._responded:
            # Headers/body already partially written — a second status line
            # would be response-splitting. Kill the connection instead.
            self.close_connection = True
            return
        self._send_json(
            err.status, {"ok": False, "error": {"code": err.code, "message": err.message}}, close=True
        )

    def _content_length(self, cap: int) -> int:
        raw = self.headers.get("Content-Length")
        try:
            length = int(raw or 0)
        except ValueError:
            raise OpError(400, "bad_request", f"Content-Length is not a number: {raw!r}")
        if length < 0:
            raise OpError(400, "bad_request", "negative Content-Length")
        if length > cap:
            raise OpError(413, "size_exceeded", f"body exceeds the {cap}-byte cap")
        return length

    def _read_json(self) -> dict:
        length = self._content_length(JSON_BODY_CAP)
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            raise OpError(400, "bad_request", "body is not valid JSON")

    def _require_url(self, body: dict) -> str:
        url = body.get("url")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            raise OpError(400, "bad_request", "'url' must be an http(s) URL")
        assert_public_host(url)
        return url

    def _stream_file(self, path: str, content_type: str, extra: dict | None = None):
        size = os.path.getsize(path)
        # Build every header value BEFORE the status line goes out, so a
        # value error can still become a clean 500 instead of a split.
        headers = [("Content-Type", content_type), ("Content-Length", str(size))]
        for k, v in (extra or {}).items():
            safe = header_safe(v)
            if safe is not None:
                headers.append((k, safe))
        self._responded = True
        self.send_response(200)
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 64 * 1024)

    # ── routes ──────────────────────────────────────────────────────────────
    def do_GET(self):  # noqa: N802
        if self.path == "/healthz":
            payload: dict = {"ok": True, "versions": get_versions(), "cookies": cookies_present()}
            if not TOKEN:
                # Degraded-but-visible beats a crash loop: with no token the
                # container serves ONLY this route and says why it is useless.
                payload = {"ok": False, "error": "MEDIA_TOKEN is not set; all media routes disabled"}
            self._send_json(200, payload)
            return
        self._send_error_env(OpError(404, "bad_request", "unknown route"))

    def do_POST(self):  # noqa: N802
        try:
            if not self._authed():
                raise OpError(401, "unauthorized", "missing or wrong bearer token")
            if self.path == "/probe":
                self._light(self._op_probe)
            elif self.path == "/captions":
                self._light(self._op_captions)
            elif self.path == "/audio":
                self._heavy(self._op_audio)
            elif self.path == "/extract-audio":
                self._heavy(self._op_extract_audio)
            elif self.path == "/video":
                self._heavy(self._op_video)
            elif self.path == "/dwf/render":
                self._heavy(self._op_dwf_render)
            else:
                raise OpError(404, "bad_request", "unknown route")
        except OpError as err:
            try:
                self._send_error_env(err)
            except OSError:
                pass
        except Exception as err:  # noqa: BLE001 — the envelope is the contract
            try:
                self._send_error_env(OpError(500, "extraction_failed", f"unexpected: {err}"))
            except OSError:
                pass

    def _gated(self, sem: threading.BoundedSemaphore, op, busy_msg: str):
        if not sem.acquire(blocking=False):
            raise OpError(429, "busy", busy_msg)
        try:
            op()
        finally:
            sem.release()

    def _heavy(self, op):
        self._gated(_slots, op, "another media job is running; retry shortly")

    def _light(self, op):
        self._gated(_light_slots, op, "too many concurrent metadata requests; retry shortly")

    def _op_probe(self):
        body = self._read_json()
        info = ytdlp_probe(self._require_url(body))
        self._send_json(200, {"ok": True, **probe_summary(info)})

    def _op_captions(self):
        body = self._read_json()
        url = self._require_url(body)
        lang = body.get("lang") if isinstance(body.get("lang"), str) else None
        prefer = body.get("prefer") or "any"
        if prefer not in ("manual", "auto", "any"):
            raise OpError(400, "bad_request", "prefer must be manual|auto|any")
        with tempfile.TemporaryDirectory() as tmp:
            self._send_json(200, fetch_captions(url, lang, prefer, tmp))

    def _op_audio(self):
        body = self._read_json()
        url = self._require_url(body)
        max_duration = int_field(body.get("maxDurationSeconds"), 3600, 1, 86_400, "maxDurationSeconds")
        max_bytes = int_field(body.get("maxBytes"), 20_000_000, 1, 2 * 1024**3, "maxBytes")
        # Probe BEFORE downloading: an over-cap or unbounded video must cost
        # a metadata call, never a download.
        info = ytdlp_probe(url)
        reject_unbounded(info)
        duration = info.get("duration")
        if duration > max_duration:
            raise OpError(
                413,
                "duration_exceeded",
                f"video is {int(duration)}s, over the {max_duration}s cap",
            )
        with tempfile.TemporaryDirectory() as tmp:
            run(
                [
                    "yt-dlp",
                    *cookie_args(tmp),
                    "-f",
                    "bestaudio/best",
                    "--no-playlist",
                    "--no-warnings",
                    "-o",
                    os.path.join(tmp, "in.%(ext)s"),
                    url,
                ],
                TIMEOUT_AUDIO,
                cwd=tmp,
            )
            src = pick_output(tmp, "in.")
            if not src:
                raise OpError(502, "extraction_failed", "yt-dlp produced no audio file")
            out = transcode_to_mp3(src, tmp, TIMEOUT_AUDIO)
            if os.path.getsize(out) > max_bytes:
                raise OpError(
                    413,
                    "size_exceeded",
                    f"extracted audio is {os.path.getsize(out)} bytes, over the {max_bytes} cap",
                )
            self._stream_file(
                out,
                "audio/mpeg",
                {"X-Media-Duration-Seconds": duration, "X-Media-Title": info.get("title")},
            )

    def _op_dwf_render(self):
        """Raster every 2D sheet of a DWF plot set via ezdwf (in-process Rust,
        no subprocess: the 9-sheet reference set renders in ~2s, and the
        heavy-op semaphore plus the client's abort timer bound a pathological
        file). Response is JSON with base64 PNGs — sheet count and cumulative
        payload are capped, and `truncated` says when either cap bit."""
        try:
            import ezdwf  # noqa: PLC0415 — lazy: absent on images built before the CAD tier
        except Exception:
            raise OpError(
                500, "extraction_failed", "ezdwf is not installed in this sidecar image"
            )
        length = self._content_length(MAX_UPLOAD_BYTES)
        if length <= 0:
            raise OpError(400, "bad_request", "raw DWF bytes required as the request body")
        dpi = int_field(self.headers.get("X-Dwf-Dpi"), 300, 50, 400, "X-Dwf-Dpi")
        max_sheets = int_field(self.headers.get("X-Dwf-Max-Sheets"), 64, 1, 256, "X-Dwf-Max-Sheets")
        payload_cap = 48 * 1024 * 1024  # raw PNG bytes before base64
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "in.dwf")
            remaining = length
            with open(src, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(64 * 1024, remaining))
                    if not chunk:
                        raise OpError(400, "bad_request", "request body ended early")
                    f.write(chunk)
                    remaining -= len(chunk)
            try:
                drawing = ezdwf.read(src)
                sheets = list(drawing.sheets)
            except Exception as err:
                raise OpError(422, "extraction_failed", f"ezdwf could not read the DWF: {err}")
            out, total, rendered = [], 0, 0
            for sheet in sheets[:max_sheets]:
                png_path = os.path.join(tmp, f"sheet-{rendered}.png")
                try:
                    sheet.save_plot(png_path, dpi=dpi)
                    with open(png_path, "rb") as f:
                        png = f.read()
                except Exception:
                    # One bad sheet must not sink the set — skip it; the count
                    # gap is visible to the caller via truncated/len(sheets).
                    continue
                if total + len(png) > payload_cap:
                    break
                total += len(png)
                width = height = None
                if len(png) > 24 and png[:8] == b"\x89PNG\r\n\x1a\n":
                    width = int.from_bytes(png[16:20], "big")
                    height = int.from_bytes(png[20:24], "big")
                out.append(
                    {
                        "name": str(getattr(sheet, "name", "") or f"sheet {rendered + 1}"),
                        "width": width,
                        "height": height,
                        "png_base64": base64.b64encode(png).decode("ascii"),
                    }
                )
                rendered += 1
            self._send_json(
                200,
                {
                    "ok": True,
                    "dpi": dpi,
                    "sheet_count": len(sheets),
                    "truncated": len(out) < len(sheets),
                    "sheets": out,
                },
            )

    def _op_extract_audio(self):
        length = self._content_length(MAX_UPLOAD_BYTES)
        if length <= 0:
            raise OpError(400, "bad_request", "raw video bytes required as the request body")
        max_duration = int_field(
            self.headers.get("X-Media-Max-Duration-Seconds"), 3600, 1, 86_400, "X-Media-Max-Duration-Seconds"
        )
        max_audio = int_field(
            self.headers.get("X-Media-Max-Audio-Bytes"), 20_000_000, 1, 2 * 1024**3, "X-Media-Max-Audio-Bytes"
        )
        with tempfile.TemporaryDirectory() as tmp:
            src = os.path.join(tmp, "in.bin")
            remaining = length
            with open(src, "wb") as f:
                while remaining > 0:
                    chunk = self.rfile.read(min(64 * 1024, remaining))
                    if not chunk:
                        raise OpError(400, "bad_request", "request body ended early")
                    f.write(chunk)
                    remaining -= len(chunk)
            duration = ffprobe_duration(src)
            if duration is not None and duration > max_duration:
                raise OpError(
                    413,
                    "duration_exceeded",
                    f"video is {int(duration)}s, over the {max_duration}s cap",
                )
            out = transcode_to_mp3(src, tmp, TIMEOUT_EXTRACT)
            if os.path.getsize(out) > max_audio:
                raise OpError(
                    413,
                    "size_exceeded",
                    f"extracted audio is {os.path.getsize(out)} bytes, over the {max_audio} cap",
                )
            self._stream_file(out, "audio/mpeg", {"X-Media-Duration-Seconds": duration})

    def _op_video(self):
        body = self._read_json()
        url = self._require_url(body)
        max_bytes = int_field(body.get("maxBytes"), 1024**3, 1, 4 * 1024**3, "maxBytes")
        info = ytdlp_probe(url)
        reject_unbounded(info)
        with tempfile.TemporaryDirectory() as tmp:
            run(
                [
                    "yt-dlp",
                    *cookie_args(tmp),
                    "-f",
                    "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
                    "--merge-output-format",
                    "mp4",
                    "--max-filesize",
                    str(max_bytes),
                    "--no-playlist",
                    "--no-warnings",
                    "-o",
                    os.path.join(tmp, "out.%(ext)s"),
                    url,
                ],
                TIMEOUT_VIDEO,
                cwd=tmp,
            )
            path = pick_output(tmp, "out.")
            if not path:
                # --max-filesize makes yt-dlp SKIP without a nonzero exit; but
                # so do a few other conditions, so say both.
                raise OpError(
                    413,
                    "size_exceeded",
                    f"no merged video produced — most likely it exceeds the {max_bytes}-byte cap",
                )
            # --max-filesize is per-STREAM; the merged file can still exceed
            # the cap. Re-check the actual artifact before shipping it.
            if os.path.getsize(path) > max_bytes:
                raise OpError(
                    413,
                    "size_exceeded",
                    f"merged video is {os.path.getsize(path)} bytes, over the {max_bytes} cap",
                )
            self._stream_file(
                path,
                "video/mp4",
                {"X-Media-Duration-Seconds": info.get("duration"), "X-Media-Title": info.get("title")},
            )


def pick_output(tmp: str, prefix: str) -> str | None:
    """The finished artifact among yt-dlp's leavings. listdir order is
    arbitrary and fragments/.part files share the prefix — prefer the exact
    merged name, else the LARGEST non-.part candidate, never whatever
    happened to list first."""
    cands = [
        f
        for f in os.listdir(tmp)
        if f.startswith(prefix) and not f.endswith(".part") and not f.endswith(".ytdl")
    ]
    if not cands:
        return None
    cands.sort(key=lambda f: os.path.getsize(os.path.join(tmp, f)), reverse=True)
    return os.path.join(tmp, cands[0])


def main():
    if not TOKEN:
        # No token = no usable routes, but a crash loop helps nobody: serve
        # /healthz with the reason so the dashboard shows WHY it is down.
        sys.stderr.write(
            "[media] MEDIA_TOKEN is not set — serving /healthz only, all media routes disabled\n"
        )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    sys.stderr.write(
        f"[media] listening on :{PORT} (max {MAX_CONCURRENT} heavy / {MAX_LIGHT_CONCURRENT} light jobs)\n"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
