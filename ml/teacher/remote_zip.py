"""Точечное чтение файла из zip-архива на удалённом диске без скачивания архива (T-076).

Архивы пакета организатора — 1–21 ГБ; нужен десяток документов из каждого. zip хранит каталог в конце,
а каждый член — сплошным куском, поэтому хватает чтения диапазонов: `rclone cat --offset --count`.
Один вызов к Яндексу ~14 с, поэтому читаем крупными блоками и заранее подкачиваем весь член одним запросом.
"""

from __future__ import annotations

import io
import subprocess
import zipfile
from collections.abc import Callable

Fetch = Callable[[int, int], bytes]  # (offset, count) → байты


def rclone_fetch(remote: str, timeout: int = 600) -> Fetch:
    def fetch(offset: int, count: int) -> bytes:
        return subprocess.run(
            ["rclone", "cat", "--offset", str(offset), "--count", str(count), remote],
            capture_output=True,
            check=True,
            timeout=timeout,
        ).stdout

    return fetch


def remote_size(remote: str) -> int:
    out = subprocess.run(
        ["rclone", "size", "--json", remote],
        capture_output=True,
        text=True,
        check=True,
        timeout=120,
    )
    import json

    return int(json.loads(out.stdout)["bytes"])


class RangeFile(io.RawIOBase):
    """Файл только для чтения поверх fetch: кэш непересекающихся кусков, промах — один запрос не меньше block."""

    def __init__(self, fetch: Fetch, size: int, block: int = 4 << 20):
        self._fetch = fetch
        self._size = size
        self._block = block
        self._pos = 0
        self._chunks: list[tuple[int, bytes]] = []  # (начало, данные)
        self.calls = 0

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self._pos

    def seek(self, offset: int, whence: int = io.SEEK_SET) -> int:
        base = {io.SEEK_SET: 0, io.SEEK_CUR: self._pos, io.SEEK_END: self._size}[whence]
        self._pos = max(0, base + offset)
        return self._pos

    def prefetch(self, offset: int, count: int) -> None:
        """Подкачать [offset, offset+count) одним запросом, если этого куска ещё нет целиком."""
        count = min(count, self._size - offset)
        if count <= 0 or self._cached(offset, count) is not None:
            return
        self.calls += 1
        data = self._fetch(offset, count)
        self._chunks.append((offset, data))

    def _cached(self, offset: int, count: int) -> bytes | None:
        for start, data in self._chunks:
            if start <= offset and offset + count <= start + len(data):
                return data[offset - start : offset - start + count]
        return None

    def readinto(self, b) -> int:  # type: ignore[override]
        n = min(len(b), self._size - self._pos)
        if n <= 0:
            return 0
        got = self._cached(self._pos, n)
        if got is None:
            self.prefetch(self._pos, max(n, self._block))
            got = self._cached(self._pos, n)
            assert got is not None
        b[: len(got)] = got
        self._pos += len(got)
        return len(got)


def fix_name(info: zipfile.ZipInfo) -> str:
    """Имена без флага UTF-8 zipfile читает как cp437; архивы с Windows несут cp866."""
    if info.flag_bits & 0x800:
        return info.filename
    try:
        return info.filename.encode("cp437").decode("cp866")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return info.filename


class RemoteZip:
    def __init__(self, fetch: Fetch, size: int):
        self.raw = RangeFile(fetch, size)
        # каталог в хвосте: подкачать последние 8 МБ одним запросом (у архива на 3774 файла каталог ~0,5 МБ)
        self.raw.prefetch(max(0, size - (8 << 20)), 8 << 20)
        self.zf = zipfile.ZipFile(io.BufferedReader(self.raw, buffer_size=1 << 20))
        self.by_name = {fix_name(i): i for i in self.zf.infolist()}

    def read(self, name: str) -> bytes:
        info = self.by_name[name]
        # локальный заголовок 30 байт + имя + extra (extra локального заголовка может отличаться — запас 64 КБ)
        self.raw.prefetch(
            info.header_offset,
            30
            + len(info.filename.encode("cp437", "replace"))
            + info.compress_size
            + (64 << 10),
        )
        with self.zf.open(info) as f:
            return f.read()
