#!/usr/bin/env python3
"""Прямой выход стенда к S3 мимо VPN (T-129): HTTP CONNECT-прокси на маке, привязанный к адресу en0.

Контейнеры Docker Desktop выходят в сеть через хост, то есть через туннель VPN, если он поднят: до Yandex Object
Storage это 3,8 МБ/с против 35 МБ/с напрямую (замер 27.09). Приём разбит на это ограничение. macOS выбирает маршрут
с оглядкой на адрес источника: сокет, привязанный к адресу en0, уходит через провайдера, даже когда default смотрит
в туннель (тот же приём, что direct_bind в translog). VPN при этом остаётся поднятым.

Безопасность: прокси пускает только разрешённые адреса (по умолчанию storage.yandexcloud.net:443), слушает только
петлю и TLS не разворачивает — через него идёт сквозной TLS клиента, содержимое (и так шифротекст) не видно.

    scripts/egress-direct.py [--port 43129] [--allow storage.yandexcloud.net:443] [--bind <адрес en0>]
"""

from __future__ import annotations

import argparse
import select
import socket
import socketserver
import subprocess
import sys


def en0_address() -> str:
    """Адрес интерфейса, через который default уходит мимо туннеля (первый default не на utun*)."""
    out = subprocess.run(
        ["netstat", "-rn", "-f", "inet"], capture_output=True, text=True, timeout=5
    ).stdout
    for line in out.splitlines():
        f = line.split()
        if len(f) >= 4 and f[0] == "default" and not f[3].startswith("utun"):
            ip = subprocess.run(
                ["ipconfig", "getifaddr", f[3]],
                capture_output=True,
                text=True,
                timeout=5,
            ).stdout.strip()
            if ip:
                return ip
    raise SystemExit("egress-direct: не нашёл интерфейс мимо VPN (default не на utun*)")


def allowed(target: str, allow: set[str]) -> bool:
    """Точное совпадение «хост:порт» или поддомен правила вида «.storage.yandexcloud.net:443» (адрес бакета — поддомен)."""
    if target in allow:
        return True
    host, _, port = target.rpartition(":")
    return any(a.startswith(".") and host.endswith(a.rsplit(":", 1)[0]) and port == a.rsplit(":", 1)[1] for a in allow)


class Handler(socketserver.StreamRequestHandler):
    allow: set[str] = set()
    bind: str = ""

    def handle(self) -> None:
        line = self.rfile.readline(4096).decode("latin1").strip()
        while self.rfile.readline(4096) not in (b"\r\n", b"\n", b""):
            pass  # заголовки запроса CONNECT не нужны
        parts = line.split()
        if (
            len(parts) != 3
            or parts[0] != "CONNECT"
            or not allowed(parts[1].lower(), self.allow)
        ):
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        host, port = parts[1].rsplit(":", 1)
        try:
            up = socket.create_connection(
                (host, int(port)), timeout=15, source_address=(self.bind, 0)
            )
        except OSError as e:
            self.wfile.write(
                f"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nX-Reason: {type(e).__name__}\r\n\r\n".encode()
            )
            return
        self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        self.wfile.flush()
        up.settimeout(None)
        a, b = self.connection, up
        try:
            while True:
                r, _, _ = select.select([a, b], [], [], 900)
                if not r:
                    break
                for s in r:
                    data = s.recv(1 << 16)
                    if not data:
                        return
                    (b if s is a else a).sendall(data)
        finally:
            up.close()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=43129)
    ap.add_argument("--listen", default="127.0.0.1")
    ap.add_argument("--allow", action="append", default=None)
    ap.add_argument("--bind", default=None)
    a = ap.parse_args()
    Handler.allow = {x.lower() for x in (a.allow or ["storage.yandexcloud.net:443", ".storage.yandexcloud.net:443"])}
    Handler.bind = a.bind or en0_address()
    with Server((a.listen, a.port), Handler) as srv:
        print(
            f"egress-direct: {a.listen}:{a.port} → {', '.join(sorted(Handler.allow))} с адреса {Handler.bind}",
            flush=True,
        )
        srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
