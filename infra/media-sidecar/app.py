#!/usr/bin/env python3
"""Media sidecar: yt-dlp + ffmpeg behind a narrow HTTP interface.

The one container in the stack allowed to run a fast-moving, auto-updating,
network-facing binary that parses hostile input from the open web. Its safety
model is ISOLATION, not trust: no database, no secrets, no file-store mounts.
It receives a URL (or raw video bytes), hands back captions/audio/video bytes,
and holds nothing between requests — fully stateless, like the Tika sidecar,
so a crash or restart loses no work.

Synchronous by design. The calling tool blocks its turn anyway (the
sandbox_exec precedent blocks up to 30 minutes), so a job/poll API would buy
nothing and cost job state, cleanup, and a polling loop. Long-op protection is
layered timeouts instead: every subprocess gets its own hard timeout here, and
the app-side client runs an AbortController backstop on top.

Routes (bearer auth on everything except /healthz):
  GET  /healthz                        -> {ok, versions:{yt_dlp, ffmpeg}}
  POST /probe          {url}           -> metadata + caption availability
  POST /captions       {url,lang?,prefer?} -> {content: "<vtt>", source, lang}
  POST /audio          {url,maxDurationSeconds?,maxBytes?} -> mp3 bytes
  POST /extract-audio  <raw video bytes>   -> mp3 bytes
  POST /video          {url,maxBytes?}     -> mp4 bytes

Error envelope on every non-2xx: {"ok":false,"error":{"code","message"}}.
Codes: unauthorized, bad_request, no_captions, extraction_failed,
duration_exceeded, size_exceeded, timeout, busy.
"""

import hmac
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from email.header import Header
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("MEDIA_PORT", "8095"))
TOKEN = os.environ.get("MEDIA_TOKEN", "")
MAX_CONCURRENT = int(os.environ.get("MEDIA_MAX_CONCURRENT", "2"))
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
STDERR_TAIL = 2048  # extraction_failed carries at most this much stderr.
CAPTIONS_CAP = 5 * 1024 * 1024  # a VTT bigger than this is not a transcript.

# Heavy ops (a download or a transcode) hold a slot; probe/captions bypass.
# Full -> immediate 429 so the caller can say "retry shortly" instead of
# queueing invisible work behind an opaque hang.
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)

# /healthz is polled by the compose healthcheck every few seconds; don't pay
# two subprocess spawns per poll. Versions move only when the refresh loop
# runs, so a short cache is honest.
_versions_cache: dict = {"at": 0.0, "value": None}
_versions_lock = threading.Lock()


def get_versions() -> dict:
    with _versions_lock:
        if _versions_cache["value"] is not None and time.time() - _versions_cache["at"] < 300:
            return _versions_cache["value"]
    ytdlp = ffmpeg = None
    try:
        ytdlp = subprocess.run(
            ["yt-dlp", "--version"], capture_output=True, text=True, timeout=20
        ).stdout.strip() or None
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
    value = {"yt_dlp": ytdlp, "ffmpeg": ffmpeg}
    with _versions_lock:
        _versions_cache.update(at=time.time(), value=value)
    return value


class OpError(Exception):
    """A failure with a wire shape: HTTP status + error code + message."""

    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def run(cmd: list, timeout: int, cwd: str | None = None) -> subprocess.CompletedProcess:
    """Run a subprocess with a hard timeout; map failures onto the envelope."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd)
    except subprocess.TimeoutExpired:
        raise OpError(504, "timeout", f"{cmd[0]} exceeded {timeout}s and was killed")
    if proc.returncode != 0:
        tail = (proc.stderr or "")[-STDERR_TAIL:]
        raise OpError(
            502,
            "extraction_failed",
            f"{cmd[0]} exited {proc.returncode}. yt-dlp self-updates daily; if this is a "
            f"site change, retry later. stderr tail:\n{tail}",
        )
    return proc


def ytdlp_probe(url: str) -> dict:
    """`yt-dlp -J` metadata. The one call every URL operation starts with."""
    proc = run(
        ["yt-dlp", "-J", "--no-download", "--no-playlist", "--no-warnings", url],
        TIMEOUT_PROBE,
    )
    try:
        info = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise OpError(502, "extraction_failed", "yt-dlp returned unparseable metadata")
    return info


def probe_summary(info: dict) -> dict:
    return {
        "title": info.get("title"),
        "durationSeconds": info.get("duration"),
        "channel": info.get("channel") or info.get("uploader"),
        "uploadDate": info.get("upload_date"),
        "extractor": info.get("extractor"),
        "captions": {
            "manual": sorted((info.get("subtitles") or {}).keys()),
            "auto": sorted((info.get("automatic_captions") or {}).keys()),
        },
        "filesizeApprox": info.get("filesize_approx"),
    }


def fetch_captions(url: str, lang: str | None, prefer: str, tmp: str) -> dict:
    """Download one caption track as VTT. Manual outranks auto for 'any'."""
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

    for source, flag, track in attempts:
        out = os.path.join(tmp, "sub")
        run(
            [
                "yt-dlp",
                "--skip-download",
                "--no-playlist",
                "--no-warnings",
                flag,
                "--sub-langs",
                track,
                "--sub-format",
                "vtt",
                "-o",
                out,
                url,
            ],
            TIMEOUT_CAPTIONS,
            cwd=tmp,
        )
        vtts = [f for f in os.listdir(tmp) if f.endswith(".vtt")]
        if vtts:
            path = os.path.join(tmp, vtts[0])
            if os.path.getsize(path) > CAPTIONS_CAP:
                raise OpError(413, "size_exceeded", "caption track exceeds 5 MB")
            with open(path, encoding="utf-8", errors="replace") as f:
                return {"ok": True, "source": source, "lang": track, "format": "vtt", "content": f.read()}
    raise OpError(404, "no_captions", "caption track advertised but not downloadable")


def transcode_to_mp3(src: str, tmp: str) -> str:
    """Speech-grade mono mp3 — the smallest thing every STT adapter accepts."""
    out = os.path.join(tmp, "out.mp3")
    run(["ffmpeg", "-y", "-i", src, "-vn", "-ac", "1", "-b:a", "32k", "-f", "mp3", out], TIMEOUT_AUDIO)
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


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Quieter than the default two-line log; one line per request.
    def log_message(self, fmt, *args):  # noqa: N802
        sys.stderr.write("[media] %s %s\n" % (self.address_string(), fmt % args))

    # ── plumbing ────────────────────────────────────────────────────────────
    def _authed(self) -> bool:
        header = self.headers.get("Authorization", "")
        expected = "Bearer " + TOKEN
        return bool(TOKEN) and hmac.compare_digest(header.encode(), expected.encode())

    def _send_json(self, status: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error_env(self, err: OpError):
        self._send_json(err.status, {"ok": False, "error": {"code": err.code, "message": err.message}})

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length > JSON_BODY_CAP:
            raise OpError(400, "bad_request", "JSON body too large")
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            raise OpError(400, "bad_request", "body is not valid JSON")

    def _require_url(self, body: dict) -> str:
        url = body.get("url")
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            raise OpError(400, "bad_request", "'url' must be an http(s) URL")
        return url

    def _stream_file(self, path: str, content_type: str, extra: dict | None = None):
        size = os.path.getsize(path)
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(size))
        for k, v in (extra or {}).items():
            if v is None:
                continue
            # Header values must be latin-1; RFC 2047 keeps titles intact.
            self.send_header(k, Header(str(v), "utf-8").encode())
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile, 64 * 1024)

    # ── routes ──────────────────────────────────────────────────────────────
    def do_GET(self):  # noqa: N802
        if self.path == "/healthz":
            self._send_json(200, {"ok": True, "versions": get_versions()})
            return
        self._send_error_env(OpError(404, "bad_request", "unknown route"))

    def do_POST(self):  # noqa: N802
        try:
            if not self._authed():
                raise OpError(401, "unauthorized", "missing or wrong bearer token")
            if self.path == "/probe":
                body = self._read_json()
                info = ytdlp_probe(self._require_url(body))
                self._send_json(200, {"ok": True, **probe_summary(info)})
            elif self.path == "/captions":
                body = self._read_json()
                url = self._require_url(body)
                lang = body.get("lang") if isinstance(body.get("lang"), str) else None
                prefer = body.get("prefer") or "any"
                if prefer not in ("manual", "auto", "any"):
                    raise OpError(400, "bad_request", "prefer must be manual|auto|any")
                with tempfile.TemporaryDirectory() as tmp:
                    self._send_json(200, fetch_captions(url, lang, prefer, tmp))
            elif self.path == "/audio":
                self._heavy(self._op_audio)
            elif self.path == "/extract-audio":
                self._heavy(self._op_extract_audio)
            elif self.path == "/video":
                self._heavy(self._op_video)
            else:
                raise OpError(404, "bad_request", "unknown route")
        except OpError as err:
            try:
                self._send_error_env(err)
            except BrokenPipeError:
                pass
        except Exception as err:  # noqa: BLE001 — the envelope is the contract
            try:
                self._send_error_env(OpError(500, "extraction_failed", f"unexpected: {err}"))
            except BrokenPipeError:
                pass

    def _heavy(self, op):
        if not _slots.acquire(blocking=False):
            raise OpError(429, "busy", "another media job is running; retry shortly")
        try:
            op()
        finally:
            _slots.release()

    def _op_audio(self):
        body = self._read_json()
        url = self._require_url(body)
        max_duration = int(body.get("maxDurationSeconds") or 3600)
        max_bytes = int(body.get("maxBytes") or 20_000_000)
        # Probe BEFORE downloading: an over-cap video must cost a metadata
        # call, never a download.
        info = ytdlp_probe(url)
        duration = info.get("duration")
        if isinstance(duration, (int, float)) and duration > max_duration:
            raise OpError(
                413,
                "duration_exceeded",
                f"video is {int(duration)}s, over the {max_duration}s cap",
            )
        with tempfile.TemporaryDirectory() as tmp:
            run(
                [
                    "yt-dlp",
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
            srcs = [f for f in os.listdir(tmp) if f.startswith("in.")]
            if not srcs:
                raise OpError(502, "extraction_failed", "yt-dlp produced no audio file")
            out = transcode_to_mp3(os.path.join(tmp, srcs[0]), tmp)
            if os.path.getsize(out) > max_bytes:
                raise OpError(
                    413,
                    "size_exceeded",
                    f"extracted audio is {os.path.getsize(out)} bytes, over the {max_bytes} cap",
                )
            self._stream_file(
                out,
                "audio/mpeg",
                {
                    "X-Media-Duration-Seconds": duration,
                    "X-Media-Title": info.get("title"),
                },
            )

    def _op_extract_audio(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise OpError(400, "bad_request", "raw video bytes required as the request body")
        if length > MAX_UPLOAD_BYTES:
            raise OpError(413, "size_exceeded", f"body exceeds the {MAX_UPLOAD_BYTES}-byte cap")
        max_duration = int(self.headers.get("X-Media-Max-Duration-Seconds") or 3600)
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
            out = transcode_to_mp3(src, tmp)
            self._stream_file(out, "audio/mpeg", {"X-Media-Duration-Seconds": duration})

    def _op_video(self):
        body = self._read_json()
        url = self._require_url(body)
        max_bytes = int(body.get("maxBytes") or 1024**3)
        info = ytdlp_probe(url)
        with tempfile.TemporaryDirectory() as tmp:
            run(
                [
                    "yt-dlp",
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
            outs = [f for f in os.listdir(tmp) if f.startswith("out.")]
            if not outs:
                # --max-filesize makes yt-dlp SKIP the download without a
                # nonzero exit; no file = the cap fired.
                raise OpError(413, "size_exceeded", f"video exceeds the {max_bytes}-byte cap")
            path = os.path.join(tmp, outs[0])
            self._stream_file(
                path,
                "video/mp4",
                {
                    "X-Media-Duration-Seconds": info.get("duration"),
                    "X-Media-Title": info.get("title"),
                },
            )


def main():
    if not TOKEN:
        # Same posture as sandboxd: an unauthenticated media fetcher is not a
        # degraded mode, it is a misconfiguration. Refuse to boot.
        sys.stderr.write("[media] MEDIA_TOKEN is required; refusing to start\n")
        sys.exit(1)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    sys.stderr.write(f"[media] listening on :{PORT} (max {MAX_CONCURRENT} concurrent jobs)\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
