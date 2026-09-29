"""Маршрутизатор OpenAI API стенда nadzorium-gpu (T-165, в репозитории с T-230 — OWASP-0212).

vLLM держит одну модель на процесс: читатель PaddleOCR-VL-1.5 — :8000, судья Qwen3.5-9B — :8001. ML ходит на один
адрес (INSPECTOR_VLM_URL = http://127.0.0.1:8010/v1), маршрутизатор выбирает процесс по полю `model` запроса.
Слушает только 127.0.0.1 (check_vlm_url пускает открытый http лишь на петлю). Запуск — deploy/gpu-stand/vllm.sh router
(systemd, DynamicUser); только стандартная библиотека python3 хоста.
"""

import json
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROUTES = {"Qwen/Qwen3.5-9B": "http://127.0.0.1:8001"}
DEFAULT = "http://127.0.0.1:8000"
MAX_BODY = (
    64 * 1024 * 1024
)  # кроп строки/листа в base64 — единицы МБ; больше — ошибка клиента, а не память маршрутизатора


class H(BaseHTTPRequestHandler):
    def _send(self, code: int, data: bytes) -> None:
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _fwd(self, base: str, body: bytes | None = None) -> None:
        req = urllib.request.Request(
            base + self.path,
            data=body,
            method=self.command,
            headers={
                "content-type": self.headers.get("content-type", "application/json")
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=600) as r:  # noqa: S310 — адреса постоянные, петля
                code, data = r.status, r.read()
        except urllib.error.HTTPError as e:
            code, data = e.code, e.read()
        self._send(code, data)

    def do_POST(self) -> None:
        n = int(self.headers.get("content-length", 0))
        if n > MAX_BODY:
            self._send(413, b'{"error":"request too large"}')
            return
        body = self.rfile.read(n)
        try:
            model = json.loads(body).get("model", "")
        except Exception:
            model = ""
        self._fwd(ROUTES.get(model, DEFAULT), body)

    def do_GET(self) -> None:
        if self.path.rstrip("/") == "/v1/models":
            data = []
            for b in [DEFAULT, *ROUTES.values()]:
                with urllib.request.urlopen(b + "/v1/models", timeout=10) as r:  # noqa: S310
                    data += json.loads(r.read())["data"]
            self._send(200, json.dumps({"object": "list", "data": data}).encode())
        else:
            self._fwd(DEFAULT)

    def log_message(self, *a) -> None:  # тексты документов и кропы в журнал не пишутся
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8010), H).serve_forever()
