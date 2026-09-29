"""T-236 real HTTP + isolated Redis + GPU OCR probe. Synthetic inputs only.

Requires the server-only launcher. Does not connect to working blobs/Redis.
"""

import json
import os
from pathlib import Path
import shutil
import socket
import threading
import time
import urllib.error
import urllib.request

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import uvicorn

from eval.resource_ocr_baseline import CASES, fixture, score
from inspector_ml.docstore import parsed_key, part_key
from inspector_ml.model import ParsedDoc


def main():
    if os.environ.get("INSPECTOR_PROFILE") != "gpu":
        raise RuntimeError("GPU profile required")
    root = Path("/baseline/http-probe")
    root.mkdir(exist_ok=False)
    blobs = root / "blobs"
    blobs.mkdir()
    os.environ["INSPECTOR_BLOB_DIR"] = str(blobs)
    font = Path(__file__).resolve().parents[2] / "assets/fonts/NotoSans.ttf"
    pdfmetrics.registerFont(TTFont("BaselineNoto", str(font)))
    native = fixture(root, CASES[-1])
    scan = fixture(root, CASES[1])
    for item in [native, scan]:
        shutil.copyfile(item["path"], blobs / item["sha256"])

    import inspector_ml.app as module
    assert module.PROFILE == "gpu"
    assert os.environ["INSPECTOR_REDIS_URL"] == "unix:///baseline/redis.sock"
    server = uvicorn.Server(uvicorn.Config(module.app, log_level="warning"))
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    events = []

    def post(route, body, status=200):
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}" + route,
            data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                actual, data = response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            actual, data = exc.code, json.load(exc)
        assert actual == status, (route, status, actual, data)
        events.append({"route": route, "status": actual, "response": data})
        return data

    try:
        deadline = time.monotonic() + 15
        while not server.started:
            if not thread.is_alive() or time.monotonic() >= deadline:
                raise RuntimeError("isolated HTTP server did not start")
            time.sleep(0.05)
        body = {"sha256": native["sha256"]}
        key = parsed_key(native["sha256"])
        assert "-r6" in key
        module.CACHE.set(key.replace("-r6", "-r5"), "{old invalid cache")
        assert post("/parse/pages", body) == {"pages": 5, "parsed": False}
        post("/parse/part", {**body, "first": 0, "last": 2})
        post("/parse/assemble", {**body, "ranges": [[0, 2]]}, 400)
        assert module.CACHE.get(key) is None
        post("/parse/assemble", {**body, "ranges": [[0, 2], [2, 5]]}, 409)
        post("/parse/part", {**body, "first": 2, "last": 5})
        part = part_key(native["sha256"], 0, 2)
        saved = module.CACHE.get(part)
        bad = json.loads(saved)
        bad["sha256"] = "f" * 64
        module.CACHE.set(part, json.dumps(bad))
        post("/parse/assemble", {**body, "ranges": [[0, 2], [2, 5]]}, 409)
        assert module.CACHE.get(key) is None
        module.CACHE.set(part, saved)
        assert post("/parse/assemble", {**body, "ranges": [[0, 2], [2, 5]]}) == {"pages": 5}
        assert post("/parse/pages", body)["parsed"] is True
        post("/parse/part", {**body, "first": 5, "last": 9}, 400)
        full = module.CACHE.get(key)
        truncated = json.loads(full)
        truncated["pages"] = truncated["pages"][:2]
        module.CACHE.set(key, json.dumps(truncated))
        post("/parse/pages", body, 409)
        post("/analyze", {**body, "params": []}, 409)
        module.CACHE.set(key, full)
        analysis = post("/analyze", {**body, "params": []})
        assert len(analysis["pages"]) == 5
        body = {"sha256": scan["sha256"]}
        post("/parse/part", {**body, "first": 0, "last": 1})
        post("/parse/assemble", {**body, "ranges": [[0, 1]]})
        warmed = post("/parse/part", {**body, "first": 0, "last": 1})
        assert warmed["cached"] is True
        document = ParsedDoc.model_validate_json(module.CACHE.get(parsed_key(scan["sha256"])))
        assert {"ppocr-v5", "vl-reader"} <= set(document.pages[0].engines)
        scores = score(document, scan)
        assert scores["field_exact"] >= 3 and scores["field_localized"] >= 3
        (root / "report.json").write_text(json.dumps({
            "revision": os.environ["BASELINE_REVISION"], "ml_revision": module.ml_revision(),
            "scope": "isolated loopback HTTP / Redis socket / real GPU OCR",
            "scan_scores": scores, "events": events}, ensure_ascii=False, indent=2))
        print(json.dumps({"result": "passed", "http_checks": len(events),
                          "ml_revision": module.ml_revision(), "scan_scores": scores}, ensure_ascii=False))
    finally:
        server.should_exit = True
        thread.join(timeout=10)
        sock.close()


if __name__ == "__main__":
    main()
