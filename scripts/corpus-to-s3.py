#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["libarchive-c>=5", "cryptography>=43"]
# ///
"""Эталонная база корпуса «Хакатон» в бакете nadzorium (T-142, этап E5 + E2; ADR-0006, ADR-0007).

Архив читается ПОТОКОМ с Яндекс.Диска (`rclone cat`), распаковывается на лету (tar/zip/rar/7z — libarchive),
вложенные архивы раскрываются тем же путём. Каждый файл шифруется на клиенте ровно как в API
(`apps/api/src/domain/blob-crypto.ts`: nonce(12) ‖ AES-256-GCM ‖ тег(16)) и ложится под ключом `blobs/<sha256 открытого
текста>` под префиксом `corpus/hackathon-2026-09/blobs/` и СВОИМ ключом `.secrets/nadzorium-corpus-encryption.key`
(мастер-ключ блобов API есть и на публичном демо — T-140 E2-H1). Одинаковый файл хранится один раз; формат тот же,
API прочтёт набор, когда BlobStore научится выбирать ключ по префиксу (T-144).

Открытый текст на диск мака не пишется (кроме временной копии вложенного архива на время его разбора). Шифротекст
копится партиями в `_S3/staging/` и уезжает в бакет ТОЛЬКО через очередь `translog` (правило №1: `enqueue --kind move`
+ `worker --once`), затем каждая партия сверяется по списку объектов бакета (размер = открытый + 28 байт).

Каталог (что лежит в бакете: архив, путь, вложенность, размер, sha256) — `_S3/catalog/<архив>.jsonl` вне git
(ADR-0002: пути реальных документов в репозиторий не попадают) и его шифрованная сборка
`corpus/hackathon-2026-09/catalog.jsonl` в бакете.

    scripts/corpus-to-s3.py ingest 14_Алтуфьевское_79Б.tar [--limit 10] [--batch-gb 2]
    scripts/corpus-to-s3.py ls [--archive 14_] [--grep КЖ] [--ext .pdf]
    scripts/corpus-to-s3.py get <sha256> -o файл.pdf           # из бакета, расшифровка и сверка sha256
    scripts/corpus-to-s3.py mark <sha256> <статус> [--note …]  # отметка агента: взял в работу, разобран, битый…
    scripts/corpus-to-s3.py catalog-push                        # сборка каталога → шифр → translog
"""

from __future__ import annotations

import argparse
import contextlib
import getpass
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import libarchive
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

ROOT = Path(__file__).resolve().parents[1]
SRC = "yandex:Загрузки/Хакатон"
BUCKET = "nadzorium:nadzorium"
PREFIX = "corpus/hackathon-2026-09/blobs"  # свой префикс и свой ключ: мастер-ключ блобов API лежит и на демо (T-140 E2-H1)
CATALOG_KEY = "corpus/hackathon-2026-09/catalog.jsonl"
WORK = Path(
    os.environ.get(
        "CORPUS_S3_WORK", Path.home() / "Documents/2026.09 ЛЦТ НАДЗОРИУМ/Хакатон/_S3"
    )
)
KEY_FILE = ROOT / ".secrets/nadzorium-corpus-encryption.key"  # только на маке; копию хранит владелец
S3_ENV = ROOT / ".secrets/yandex-s3-nadzorium.env"
TRANSLOG_DB = Path.home() / "Documents/ЛОГ_ПЕРЕНОСОВ.sqlite"
NESTED = (".zip", ".rar", ".7z", ".tar")
NESTED_MAX_DEPTH = 3
NESTED_MAX_BYTES = (
    30 * 1024**3
)  # предел раскрытия одного вложенного архива (защита от «бомбы»)
OVERHEAD = 12 + 16
CHUNK = 1 << 20
MIN_FREE_GB = 12  # ниже — чтение архива ждёт, пока партии уедут


# ── шифр: формат API ────────────────────────────────────────────────────────────────────────────────────────────


def load_key() -> bytes:
    t = KEY_FILE.read_text().strip()
    if re.fullmatch(r"[0-9a-fA-F]{64}", t):
        return bytes.fromhex(t)
    import base64

    k = base64.b64decode(
        t + "=" * (-len(t) % 4), altchars=b"-_" if ("-" in t or "_" in t) else None
    )
    if len(k) != 32:
        sys.exit("ключ шифрования: ждём 32 байта")
    return k


class Sealer:
    """Потоковое AES-256-GCM + SHA-256 открытого текста; выход — nonce ‖ шифротекст ‖ тег, как encryptBlob в API."""

    def __init__(self, key: bytes, out, plain_copy=None):
        self.nonce = os.urandom(12)
        self.enc = Cipher(algorithms.AES(key), modes.GCM(self.nonce)).encryptor()
        self.sha = hashlib.sha256()
        self.out, self.plain, self.n = out, plain_copy, 0
        out.write(self.nonce)

    def update(self, b: bytes) -> None:
        self.sha.update(b)
        self.n += len(b)
        self.out.write(self.enc.update(b))
        if self.plain:
            self.plain.write(b)

    def close(self) -> str:
        self.out.write(self.enc.finalize())
        self.out.write(self.enc.tag)
        return self.sha.hexdigest()


def open_blob(key: bytes, blob: bytes) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    return AESGCM(key).decrypt(blob[:12], blob[12:], None)


# ── окружение ───────────────────────────────────────────────────────────────────────────────────────────────────


def s3_env() -> dict:
    env = dict(os.environ)
    for line in S3_ENV.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def en0() -> str | None:
    r = subprocess.run(["ipconfig", "getifaddr", "en0"], capture_output=True, text=True)
    return r.stdout.strip() or None


def free_gb() -> float:
    return shutil.disk_usage(WORK).free / 1e9


def log(msg: str) -> None:
    line = f"{datetime.now():%H:%M:%S} {msg}"
    print(line, flush=True)
    with open(WORK / "ingest.log", "a") as f:
        f.write(line + "\n")


def bucket_shas(env: dict) -> set[str]:
    r = subprocess.run(["rclone", "lsf", f"{BUCKET}/{PREFIX}", "--files-only"], capture_output=True, text=True, env=env)
    if r.returncode and "not found" not in r.stderr:
        raise RuntimeError(f"rclone lsf {PREFIX}: {r.stderr[-300:]}")
    return {x.strip() for x in r.stdout.split() if re.fullmatch(r"[0-9a-f]{64}", x.strip())}


# ── заливка партий через translog ───────────────────────────────────────────────────────────────────────────────


def job_state(job: int) -> tuple[str, str | None]:
    c = sqlite3.connect(f"file:{TRANSLOG_DB}?mode=ro", uri=True, timeout=30)
    r = c.execute("SELECT state, last_error FROM jobs WHERE id=?", (job,)).fetchone()
    c.close()
    return (r[0], r[1]) if r else ("missing", None)


def ship(batch: Path, what: str, env: dict) -> None:
    """Партия шифротекста → бакет через очередь translog; ждём done и сверяем каждый объект по размеру."""
    sizes = {p.name: p.stat().st_size for p in batch.iterdir() if p.is_file()}
    if not sizes:
        batch.rmdir()
        return
    out = subprocess.run(
        [
            "translog",
            "enqueue",
            "--no-push",
            "--kind",
            "move",
            "--src",
            str(batch),
            "--dst",
            f"{BUCKET}/{PREFIX}",
            "--what",
            what,
            "--prio",
            "-10",
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    m = re.search(r"#(\d+)", out.stdout + out.stderr)
    if out.returncode or not m:
        raise RuntimeError(f"translog enqueue: {out.stdout[-300:]} {out.stderr[-300:]}")
    job = int(m.group(1))
    while True:
        st, err = job_state(job)
        if st == "done":
            break
        if st == "failed":
            raise RuntimeError(f"translog #{job} провалено: {err}")
        if st == "queued":
            # свой воркер на одно задание; если воркер машины уже крутится — он возьмёт наше (prio -10) сам
            subprocess.run(
                ["translog", "worker", "--once", "--no-push"],
                capture_output=True,
                text=True,
                env=env,
            )
        time.sleep(5)
    listing = subprocess.run(
        [
            "rclone",
            "lsjson",
            f"{BUCKET}/{PREFIX}",
            "--files-from-raw",
            "/dev/stdin",
            "--no-modtime",
            "--no-mimetype",
        ],
        input="\n".join(sizes),
        capture_output=True,
        text=True,
        env=env,
        check=True,
    )
    got = {o["Path"]: o["Size"] for o in json.loads(listing.stdout)}
    bad = [k for k, v in sizes.items() if got.get(k) != v]
    if bad:
        raise RuntimeError(
            f"партия {batch.name}: в бакете нет или не того размера {len(bad)} объектов, первый {bad[0]}"
        )
    with open(WORK / "verified.txt", "a") as f:
        f.write("".join(k + "\n" for k in sizes))
    with contextlib.suppress(OSError):
        batch.rmdir()  # move уже увёз файлы; пустая папка
    log(
        f"✓ партия {batch.name}: {len(sizes)} объектов, {sum(sizes.values()) / 1e9:.2f} ГБ — в бакете, сверено (translog #{job})"
    )


class Shipper(threading.Thread):
    def __init__(self, env: dict):
        super().__init__(daemon=True)
        self.env, self.q, self.err = env, [], None
        self.cv = threading.Condition()
        self.done = False

    def put(self, batch: Path, what: str) -> None:
        with self.cv:
            self.q.append((batch, what))
            self.cv.notify_all()
            # не больше одной запечатанной партии в ожидании: диск мака почти полон
            while len(self.q) > 1 and not self.err:
                self.cv.wait(5)
        if self.err:
            raise self.err

    def finish(self) -> None:
        with self.cv:
            self.done = True
            self.cv.notify_all()
        self.join()
        if self.err:
            raise self.err

    def run(self) -> None:
        while True:
            with self.cv:
                while not self.q and not self.done:
                    self.cv.wait(5)
                if not self.q:
                    return
                batch, what = self.q[0]
            try:
                ship(batch, what, self.env)
            except Exception as e:  # noqa: BLE001 — любой сбой останавливает чтение, партия остаётся на диске
                self.err = e
            with self.cv:
                self.q.pop(0)
                self.cv.notify_all()
            if self.err:
                return


def fixname(p) -> str:
    """Имя из архива: libarchive отдаёт str (UTF-8 или флаг zip) или bytes, если не смог; zip из Windows без флага — CP866."""
    if isinstance(p, str):
        return p
    if not p:
        return ""
    try:
        return p.decode("utf-8")
    except UnicodeDecodeError:
        return p.decode("cp866")


# ── распаковка потоком ──────────────────────────────────────────────────────────────────────────────────────────


class Ingest:
    def __init__(
        self,
        archive: str,
        key: bytes,
        known: set[str],
        shipper: Shipper,
        batch_bytes: int,
        limit: int | None,
    ):
        self.archive, self.key, self.known, self.shipper = archive, key, known, shipper
        self.batch_bytes, self.limit = batch_bytes, limit
        self.files = self.new_blobs = self.dup = 0
        self.bytes = 0
        self.batch_no = 0
        self.cat = open(WORK / "catalog" / f"{archive}.jsonl", "a")
        self.errors = open(WORK / "catalog" / f"{archive}.errors.jsonl", "a")
        self._open_batch()

    def _open_batch(self) -> None:
        self.batch_no += 1
        self.batch = (
            WORK
            / "staging"
            / f"{Path(self.archive).stem}-{os.getpid()}-{self.batch_no:04d}"
        )
        self.batch.mkdir(parents=True, exist_ok=True)
        self.batch_size = 0

    def seal(self, last: bool = False) -> None:
        what = f"T-142 корпус «Хакатон» → бакет nadzorium: {self.archive}, партия {self.batch_no} (шифр ADR-0006)"
        self.shipper.put(self.batch, what)
        if not last:
            self._open_batch()

    def entry(self, e, path: str, parent: str | None, depth: int) -> None:
        if self.limit is not None and self.files >= self.limit:
            return
        while free_gb() < MIN_FREE_GB:
            log(
                f"диск: свободно {free_gb():.1f} ГБ < {MIN_FREE_GB} — жду, пока уедут партии"
            )
            time.sleep(30)
        tmp = self.batch / f".part-{self.files}"
        nested = depth < NESTED_MAX_DEPTH and path.lower().endswith(NESTED)
        plain = (
            tempfile.NamedTemporaryFile(dir=WORK / "tmp", delete=False)
            if nested
            else None
        )
        with open(tmp, "wb") as out:
            s = Sealer(self.key, out, plain)
            for block in e.get_blocks(CHUNK):
                s.update(block)
            sha = s.close()
        if plain:
            plain.close()
        self.files += 1
        self.bytes += s.n
        row = {
            "archive": self.archive,
            "path": path,
            "parent_sha256": parent,
            "depth": depth,
            "bytes": s.n,
            "sha256": sha,
            "ext": Path(path).suffix.lower(),
            "object": path.split("/", 1)[0],
            "blob": f"{PREFIX}/{sha}",
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        }
        if sha in self.known:
            tmp.unlink()
            self.dup += 1
            row["stored"] = "already"
        else:
            tmp.rename(self.batch / sha)
            self.known.add(sha)
            self.new_blobs += 1
            self.batch_size += s.n + OVERHEAD
            row["stored"] = "new"
        self.cat.write(json.dumps(row, ensure_ascii=False) + "\n")
        self.cat.flush()
        if self.files % 100 == 0:
            log(
                f"  {self.archive}: {self.files} файлов, {self.bytes / 1e9:.2f} ГБ, новых {self.new_blobs}, дублей {self.dup}"
            )
        if plain:
            try:
                self.walk_file(plain.name, f"{path}!", sha, depth + 1)
            finally:
                os.unlink(plain.name)
        if self.batch_size >= self.batch_bytes:
            self.seal()

    def walk(self, reader, prefix: str, parent: str | None, depth: int) -> None:
        budget = NESTED_MAX_BYTES
        for e in reader:
            if not e.isfile:
                continue
            path = prefix + fixname(e.pathname).lstrip("./")
            if depth and (e.size or 0) > budget:
                self.bad(path, "вложенный архив больше предела раскрытия")
                return
            budget -= e.size or 0
            self.entry(e, path, parent, depth)

    def walk_file(self, fname: str, prefix: str, parent: str, depth: int) -> None:
        try:
            with libarchive.file_reader(fname) as r:
                self.walk(r, prefix, parent, depth)
        except libarchive.ArchiveError as ex:
            self.bad(prefix, f"вложенный архив не раскрыт: {str(ex)[:200]}")

    def bad(self, path: str, why: str) -> None:
        self.errors.write(
            json.dumps(
                {"archive": self.archive, "path": path, "error": why},
                ensure_ascii=False,
            )
            + "\n"
        )
        self.errors.flush()
        log(f"  ⚠ {path}: {why}")


def cmd_ingest(a) -> None:
    for d in ("catalog", "staging", "tmp"):
        (WORK / d).mkdir(parents=True, exist_ok=True)
    env = s3_env()
    key = load_key()
    known = bucket_shas(env)
    log(
        f"▶ {a.archive}: в бакете уже {len(known)} объектов; свободно {free_gb():.1f} ГБ"
    )
    shipper = Shipper(env)
    shipper.start()
    ing = Ingest(a.archive, key, known, shipper, int(a.batch_gb * 1e9), a.limit)
    cmd = [
        "rclone",
        "cat",
        f"{SRC}/{a.archive}",
        "--low-level-retries",
        "20",
        "--retries",
        "5",
    ]
    if ip := en0():
        cmd += ["--bind", ip]  # мимо VPN, как translog direct_bind
    t0 = time.time()
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, env=env)
    try:
        with libarchive.stream_reader(p.stdout) as r:
            ing.walk(r, "", None, 0)
    finally:
        if a.limit is not None:
            p.kill()
        p.wait()
    ing.seal(last=True)
    shipper.finish()
    dt = time.time() - t0
    log(
        f"■ {a.archive}: файлов {ing.files} ({ing.bytes / 1e9:.2f} ГБ открытого текста), новых объектов {ing.new_blobs}, "
        f"уже были {ing.dup}; {dt / 60:.1f} мин, {ing.bytes / 1e6 / max(dt, 1):.1f} МБ/с"
    )
    with open(WORK / "done-archives.txt", "a") as f:
        f.write(
            f"{a.archive}\t{ing.files}\t{ing.bytes}\t{ing.new_blobs}\t{'LIMIT ' + str(a.limit) if a.limit else 'FULL'}\n"
        )


# ── чтение для агентов ──────────────────────────────────────────────────────────────────────────────────────────


def catalog_rows():
    for f in sorted((WORK / "catalog").glob("*.jsonl")):
        if f.name.endswith(".errors.jsonl"):
            continue
        for line in open(f):
            yield json.loads(line)


def cmd_ls(a) -> None:
    n = 0
    for r in catalog_rows():
        if a.archive and not r["archive"].startswith(a.archive):
            continue
        if a.ext and r["ext"] != a.ext.lower():
            continue
        if a.grep and not re.search(a.grep, r["path"], re.I):
            continue
        print(f"{r['sha256']}  {r['bytes']:>11}  {r['archive']}  {r['path']}")
        n += 1
    print(f"— {n} файлов", file=sys.stderr)


def cmd_get(a) -> None:
    env = s3_env()
    blob = subprocess.run(
        ["rclone", "cat", f"{BUCKET}/{PREFIX}/{a.sha}"],
        capture_output=True,
        env=env,
        check=True,
    ).stdout
    plain = open_blob(load_key(), blob)
    if hashlib.sha256(plain).hexdigest() != a.sha:
        sys.exit("sha256 расшифрованного не совпал с ключом объекта — объект испорчен")
    Path(a.out).write_bytes(plain)
    print(f"{a.out}: {len(plain)} байт, sha256 сверен")


def cmd_mark(a) -> None:
    row = {
        "sha256": a.sha,
        "status": a.status,
        "note": a.note,
        "by": a.by or getpass.getuser(),
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    with open(WORK / "marks.jsonl", "a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print("отмечено:", row)


def cmd_catalog_push(a) -> None:
    """Каталог и отметки → один шифрованный объект в бакете (через translog), чтобы база была самоописывающей."""
    env = s3_env()
    key = load_key()
    stage = WORK / "staging" / f"catalog-{os.getpid()}"
    dst_dir = stage / Path(CATALOG_KEY).parent
    dst_dir.mkdir(parents=True, exist_ok=True)
    rows = list(catalog_rows())
    marks = (
        [json.loads(x) for x in open(WORK / "marks.jsonl")]
        if (WORK / "marks.jsonl").exists()
        else []
    )
    body = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows) + "".join(
        json.dumps({"mark": m}, ensure_ascii=False) + "\n" for m in marks
    )
    with open(dst_dir / Path(CATALOG_KEY).name, "wb") as out:
        s = Sealer(key, out)
        s.update(body.encode())
        s.close()
    out = subprocess.run(
        [
            "translog",
            "enqueue",
            "--no-push",
            "--kind",
            "copy",
            "--src",
            str(stage / "corpus"),
            "--dst",
            f"{BUCKET}/corpus",
            "--what",
            f"T-142 каталог эталонной базы: {len(rows)} строк, шифр ADR-0006",
            "--prio",
            "-10",
        ],
        capture_output=True,
        text=True,
        env=env,
    )
    m = re.search(r"#(\d+)", out.stdout + out.stderr)
    if not m:
        sys.exit(out.stdout + out.stderr)
    job = int(m.group(1))
    while (st := job_state(job)[0]) not in ("done", "failed"):
        if st == "queued":
            subprocess.run(
                ["translog", "worker", "--once", "--no-push"],
                capture_output=True,
                env=env,
            )
        time.sleep(5)
    print(
        f"каталог: {len(rows)} строк, отметок {len(marks)} → {BUCKET}/{CATALOG_KEY} — translog #{job} {st}"
    )
    shutil.rmtree(stage, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(required=True)
    s = sub.add_parser("ingest")
    s.add_argument("archive")
    s.add_argument("--limit", type=int)
    s.add_argument("--batch-gb", type=float, default=2.0)
    s.set_defaults(fn=cmd_ingest)
    s = sub.add_parser("ls")
    s.add_argument("--archive")
    s.add_argument("--grep")
    s.add_argument("--ext")
    s.set_defaults(fn=cmd_ls)
    s = sub.add_parser("get")
    s.add_argument("sha")
    s.add_argument("-o", "--out", required=True)
    s.set_defaults(fn=cmd_get)
    s = sub.add_parser("mark")
    s.add_argument("sha")
    s.add_argument("status")
    s.add_argument("--note")
    s.add_argument("--by")
    s.set_defaults(fn=cmd_mark)
    s = sub.add_parser("catalog-push")
    s.set_defaults(fn=cmd_catalog_push)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
