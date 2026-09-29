"""Точка входа ML-образа (NFR-TLS-INTERNAL, ТЗ 1.3): внутри стенда открытого текста нет.

INSPECTOR_ML_TLS_CERT и INSPECTOR_ML_TLS_KEY заданы — HTTPS, минимум TLS 1.3 (TLS 1.2 и ниже отвергаются
рукопожатием). Не заданы — HTTP, как раньше (dev, тесты, smoke гейта). Задан только один — отказ старта:
половинчатая настройка не должна молча превращаться в открытый текст.

uvicorn CLI не умеет задавать минимальную версию TLS (--ssl-version выбирает протокол, а не нижнюю границу),
поэтому контекст собирается uvicorn как обычно и затем ужесточается до запуска сервера.
"""

from __future__ import annotations

import os
import ssl

import uvicorn


class Tls13Config(uvicorn.Config):
    """TLS не ниже 1.3 — в каждом процессе: контекст SSL не передаётся в дочерний процесс, его собирает load() там."""

    def load(self) -> None:
        super().load()
        if self.ssl is not None:
            self.ssl.minimum_version = ssl.TLSVersion.TLSv1_3


def workers(env: dict | None = None) -> int:
    """INSPECTOR_ML_WORKERS — процессов ML (T-233): растеризация pdfium идёт под замком процесса (PDFIUM_LOCK), один
    процесс рисует одну страницу за раз, и GPU ждёт. По умолчанию 1; предел 8."""
    raw = (os.environ if env is None else env).get("INSPECTOR_ML_WORKERS", "1")
    try:
        return min(max(int(raw), 1), 8)
    except ValueError:
        raise SystemExit(f"INSPECTOR_ML_WORKERS={raw!r}: ждём целое 1…8")


def main() -> None:
    cert = os.environ.get("INSPECTOR_ML_TLS_CERT", "").strip()
    key = os.environ.get("INSPECTOR_ML_TLS_KEY", "").strip()
    if bool(cert) != bool(key):
        raise SystemExit(
            "INSPECTOR_ML_TLS_CERT и INSPECTOR_ML_TLS_KEY задаются только вместе"
        )
    n = workers()
    supervised = bool(os.environ.get("INSPECTOR_NODE_POLICY"))
    if supervised and n != 1:
        raise SystemExit("node supervisor requires INSPECTOR_ML_WORKERS=1")
    config = Tls13Config(
        "inspector_ml.node_supervisor:build_from_env" if supervised else "inspector_ml.app:app",
        factory=supervised,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8811")),
        log_level="warning",
        ssl_certfile=cert or None,
        ssl_keyfile=key or None,
        workers=n,
    )
    if n == 1:
        uvicorn.Server(config).run()
        return
    # несколько процессов на одном сокете: каждый со своим pdfium и своей моделью OCR (арена CUDA — INSPECTOR_PPOCR_GPU_MB)
    from uvicorn.supervisors import Multiprocess

    sock = config.bind_socket()
    Multiprocess(config, sockets=[sock]).run()  # uvicorn ≥ 0.54: сервер собирается в каждом процессе из config (load → TLS 1.3)


if __name__ == "__main__":
    main()
