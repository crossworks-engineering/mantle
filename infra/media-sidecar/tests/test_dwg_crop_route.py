"""The image check's HTTP route, POST /dwg/crop, on a real sidecar process:
the bearer token, the crop spec read ahead of the drawing bytes (its
length in X-Crop-Spec-Length, capped), a bad spec refused with the field
it names before any child runs, and (with ezdxf and matplotlib) a
synthetic DXF answered with base64 PNG crops and an overview. Never a real
drawing: the repo is public.

Run:
    python3 -m unittest discover -s infra/media-sidecar/tests -v
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(os.path.dirname(HERE), "app.py")
TOKEN = "crop-route-test-token"

try:
    import ezdxf  # noqa: F401
    import matplotlib  # noqa: F401

    HAVE_RENDER = True
except Exception:  # pragma: no cover - the venv case
    HAVE_RENDER = False
    if os.environ.get("MEDIA_TESTS_REQUIRE_EZDXF"):
        raise


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class CropRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = free_port()
        env = dict(os.environ, MEDIA_TOKEN=TOKEN, MEDIA_PORT=str(cls.port))
        cls.proc = subprocess.Popen(
            [sys.executable, APP], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE
        )
        deadline = time.time() + 20
        while time.time() < deadline:
            try:
                status, _ = cls.request("GET", "/healthz", b"", {})
                if status == 200:
                    return
            except OSError:
                time.sleep(0.1)
        cls.proc.kill()
        raise RuntimeError("the sidecar did not start")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:  # pragma: no cover
            cls.proc.kill()
        if cls.proc.stderr:
            cls.proc.stderr.close()

    @classmethod
    def request(cls, method, path, body, headers):
        conn = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=200)
        try:
            conn.request(method, path, body=body, headers=headers)
            res = conn.getresponse()
            return res.status, json.loads(res.read() or b"{}")
        finally:
            conn.close()

    def crop(self, spec, drawing: bytes, *, token=TOKEN, spec_len=None):
        head = spec if isinstance(spec, bytes) else json.dumps(spec).encode()
        headers = {
            "Content-Type": "application/octet-stream",
            "X-Crop-Spec-Length": str(len(head) if spec_len is None else spec_len),
        }
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        return self.request("POST", "/dwg/crop", head + drawing, headers)

    def spec(self):
        return {
            "items": [{"id": "end", "kind": "point", "at": [400, 300], "pad": 50,
                       "marks": [[400, 300]]}],
            "overlay": [{"color": "main", "segs": [[0, 0, 400, 0]]}],
        }

    def test_without_the_token_it_is_refused(self):
        status, body = self.crop(self.spec(), b"0\nSECTION\n", token=None)
        self.assertEqual(status, 401)
        self.assertEqual(body["error"]["code"], "unauthorized")

    def test_a_bad_spec_is_refused_with_its_field_before_any_child(self):
        bad = {"items": [{"id": "a", "kind": "point", "at": [0, 0], "pad": 0}]}
        status, body = self.crop(bad, b"0\nSECTION\n")
        self.assertEqual(status, 400)
        self.assertIn("items[0].pad", body["error"]["message"])

    def test_a_spec_past_the_cap_is_refused(self):
        status, body = self.crop(self.spec(), b"x", spec_len=512 * 1024 + 1)
        self.assertEqual(status, 400)
        self.assertIn("X-Crop-Spec-Length", body["error"]["message"])

    def test_a_body_with_no_drawing_after_the_spec_is_refused(self):
        status, body = self.crop(self.spec(), b"")
        self.assertEqual(status, 400)
        self.assertIn("the crop spec, then the drawing bytes", body["error"]["message"])

    @unittest.skipUnless(HAVE_RENDER, "ezdxf and matplotlib are not installed")
    def test_a_synthetic_drawing_comes_back_as_png_crops(self):
        doc = ezdxf.new("R2013")
        msp = doc.modelspace()
        doc.layers.add("Circuit 90000-030-01")
        msp.add_line((0, 0), (400, 0), dxfattribs={"layer": "Circuit 90000-030-01"})
        msp.add_line((400, 0), (400, 300), dxfattribs={"layer": "Circuit 90000-030-01"})
        msp.add_text("V-301", dxfattribs={"insert": (390, 335), "height": 5})
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "synthetic.dxf")
            doc.saveas(path)
            with open(path, "rb") as f:
                drawing = f.read()
        status, body = self.crop(self.spec(), drawing)
        self.assertEqual(status, 200, body)
        self.assertTrue(body["ok"])
        self.assertEqual([c["id"] for c in body["crops"]], ["end"])
        png = base64.b64decode(body["crops"][0]["png_base64"])
        self.assertEqual(png[:8], b"\x89PNG\r\n\x1a\n")
        self.assertTrue(base64.b64decode(body["overview"]["png_base64"]).startswith(b"\x89PNG"))


if __name__ == "__main__":
    unittest.main()
