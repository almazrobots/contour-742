"""OCR сканов на видеокарте и выбор движков конфигурацией (T-184, OS-INSP-2.1.17, 2.1.18).

Решение владельца 28.09: «Никакого Tesseract на CPU. OCR — на видеокарте, GPU-модель первична».

Набор движков ансамбля задаёт `INSPECTOR_OCR_ENGINES` (имена через запятую). Умолчание профиля dev (мак) — три
прохода Tesseract, как раньше; профиля gpu — `ppocr-v5,vl-reader`:

- `ppocr-v5` — PP-OCRv5: детектор строк + распознаватель кириллицы (RapidOCR, ONNX Runtime на CUDA). Даёт слова
  с рамками и уверенностью — это «якорь» геометрии страницы;
- `vl-reader` — PaddleOCR-VL-1.5 через vLLM (OpenAI API): рамок слов не даёт, поэтому читает каждую строку якоря
  отдельным кропом (запросы идут параллельно — vLLM собирает их в пакет), а слова прочтения выравниваются со
  словами строки якоря и получают их рамки. Так VL — второй независимый голос в том же голосовании по словам.

В профиле gpu Tesseract запрещён, а недоступный движок (нет CUDA, нет сервера vLLM) — громкая ошибка старта
(`check_ready`), а не тихий откат на CPU.
"""

from __future__ import annotations

import difflib
import json
import logging
import os
import queue
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
from PIL import Image

from .model import BBox, Line, Word
from .normalize import nfc

log = logging.getLogger(__name__)

ENGINES_ENV = "INSPECTOR_OCR_ENGINES"
TESSERACT = ("tesseract-psm4", "tesseract-prep", "tesseract-psm6")
DEFAULT_ENGINES = {"dev": TESSERACT, "gpu": ("ppocr-v5", "vl-reader")}
# PP-OCR на GPU: детектор PP-OCRv6 medium + распознаватель PP-OCRv5 eslav (кириллица и латиница шифров) — выбор по замеру,
# ml/models.yaml → ocr_anchor. Распознаватель cyrillic транслитерировал латиницу шифров (ALT → АЛТ, POL → РОЛ).
PPOCR_REC = os.environ.get("INSPECTOR_PPOCR_REC", "eslav")
PPOCR_DET = "v6-medium"
PPOCR_MODEL = "PaddlePaddle/PP-OCRv6_medium_det+eslav_PP-OCRv5_mobile_rec"
# Веса PP-OCR — только локальные файлы (T-230, OWASP-0211): каталог из образа ML gpu (ADD --checksum при сборке),
# при старте — сверка SHA-256 с реестром ml/models.yaml → ocr_anchor.files. Без каталога в профиле gpu — отказ:
# RapidOCR сам качал бы веса с modelscope.cn в рантайме без проверки при первой загрузке.
MODEL_DIR_ENV = "INSPECTOR_PPOCR_MODEL_DIR"
MODELS_YAML_ENV = "INSPECTOR_MODELS_YAML"
DET_FILES = {
    "v6-medium": "PP-OCRv6_det_medium.onnx",
    "v5-server": "ch_PP-OCRv5_det_server.onnx",
    "v5-mobile": "ch_PP-OCRv5_det_mobile.onnx",
}
# Вход детектора — доля длинной стороны листа, а не одно число на все форматы (T-232, замер 28.09 на 4090):
# А4 3509 px — полнота 98–100 % при входе 1600 (доля 0,46), 60–72 % при 2400–4096 (доля ≥ 0,68: крупный шрифт
# не ловится); А0 14042 px — 13 % при 1600 (доля 0,11), 93 % при 3200–4096 (доли 0,23–0,29).
DET_SCALE = (
    0.45  # целевая доля: вход = длинная сторона × доля, в пределах [DET_FLOOR, потолок]
)
DET_FLOOR = 1600
DET_MIN_SCALE = (
    0.25  # ниже — мелкий текст теряется: лист режется на куски, каждый со своим входом
)
DET_PIECE_OVERLAP = (
    512  # перекрытие кусков, px: строка на шве целиком попадает хотя бы в один кусок
)
# Арену CUDA детектор расходует по площади входа (замер 28.09): 3200×2264 (7,2 Мп) проходит в 3 ГБ и падает в 2 ГБ,
# 4096×2898 (11,9 Мп) — в 4 ГБ и падает в 3 ГБ (ONNX Concat/MaxPool); почти квадратный кусок 3493×3205 (11,2 Мп)
# в 4 ГБ падает, в 6 ГБ проходит. Запас — 1,9 Мп входа на ГБ арены; арена по умолчанию 6 ГБ (А0 целиком на 4096).
DET_MPX_PER_GB = 1.9
CLS_FILE = "ch_PP-LCNet_x0_25_textline_ori_cls_mobile.onnx"  # PP-OCRv5 mobile — классификатор ориентации строки


def rec_file(rec: str) -> str:
    return f"{rec}_PP-OCRv5_rec_mobile.onnx"


def pinned_weights() -> dict[str, str]:
    """Имя файла весов → SHA-256 из реестра моделей (ocr_anchor.files)."""
    from pathlib import Path

    import yaml

    path = (
        os.environ.get(MODELS_YAML_ENV)
        or Path(__file__).resolve().parents[1] / "models.yaml"
    )
    with open(path, encoding="utf-8") as f:
        files = yaml.safe_load(f)["roles"]["ocr_anchor"].get("files") or []
    return {str(x["file"]): str(x["sha256"]).lower() for x in files}


def local_model_paths(model_dir: str, det: str, rec: str) -> dict[str, str]:
    """Пути Det/Cls/Rec.model_path в каталоге весов после сверки SHA-256 с реестром. Любое расхождение —
    RuntimeError с причиной (движок недоступен), а не загрузка из сети."""
    import hashlib
    from pathlib import Path

    names = {
        "Det": DET_FILES.get(det, f"{det}?"),
        "Cls": CLS_FILE,
        "Rec": rec_file(rec),
    }
    pins = pinned_weights()
    out = {}
    for stage, name in names.items():
        p = Path(model_dir) / name
        if name not in pins:
            raise RuntimeError(
                f"{name}: нет SHA-256 в реестре ml/models.yaml (ocr_anchor.files)"
            )
        if not p.is_file():
            raise RuntimeError(f"{MODEL_DIR_ENV}: нет файла {p}")
        h = hashlib.sha256()
        with open(p, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        if h.hexdigest() != pins[name]:
            raise RuntimeError(
                f"{name}: SHA-256 {h.hexdigest()[:12]}… не совпал с реестром {pins[name][:12]}… — веса подменены"
            )
        out[f"{stage}.model_path"] = str(p)
    return out


VL_CONF = 85.0  # уверенность голоса VL (модель её не отдаёт): при ничьей 1:1 PP-OCR с уверенностью строки > 0,85 выигрывает
VL_PROMPT = "OCR:"  # задача распознавания текста PaddleOCR-VL (промпт обучения модели)


class ReaderWords(list):
    """List-compatible result with per-call failures; no shared engine state."""

    def __init__(self, words, failures):
        super().__init__(words)
        self.execution_failures = sorted(failures)


class OcrConfigError(RuntimeError):
    """Конфигурация OCR непригодна для профиля: громкая ошибка старта (OS-INSP-2.1.18)."""


# ─────────────────────────────────────────────── конфигурация


def engine_names(profile: str, env: dict | None = None) -> tuple[str, ...]:
    """Имена движков ансамбля: INSPECTOR_OCR_ENGINES или умолчание профиля. Неизвестное имя — ошибка;
    Tesseract в профиле gpu — ошибка (решение владельца 28.09)."""
    e = os.environ if env is None else env
    raw = (e.get(ENGINES_ENV) or "").strip()
    names = (
        tuple(dict.fromkeys(n.strip() for n in raw.split(",") if n.strip()))
        if raw
        else DEFAULT_ENGINES.get(profile, TESSERACT)
    )
    unknown = [n for n in names if n not in FACTORIES]
    if unknown:
        raise OcrConfigError(
            f"{ENGINES_ENV}: неизвестные движки {', '.join(unknown)}; есть {', '.join(sorted(FACTORIES))}"
        )
    if profile == "gpu":
        cpu = [n for n in names if n.startswith("tesseract")]
        if cpu:
            raise OcrConfigError(
                f"{ENGINES_ENV}: {', '.join(cpu)} — Tesseract на CPU в профиле gpu запрещён (T-184)"
            )
    return names


def ocr_tag(env: dict | None = None) -> str:
    """Метка набора движков для ключа кэша разбора и ревизии ML: умолчание dev (Tesseract ×3) — пусто, иначе
    «-o» + 8 знаков хеша набора. Разбор другими движками — другой результат, а не старый из кэша (OS-INSP-2.1.12)."""
    import hashlib

    from .page_passport import mode as passport_mode, signature as passport_signature

    e = os.environ if env is None else env
    names = engine_names(e.get("INSPECTOR_PROFILE", "dev"), e)
    # T-216: пропуск пустых листов и листов подписи паспортом страницы меняет прочтение — в ключ кэша и ревизию ML
    # (иначе стенд не переанализирует по ревизии, F08); при off ключ прежний — кэш разбора не теряется
    pp = f"|pp={passport_signature()}" if passport_mode(e) == "skip" else ""
    if names == TESSERACT and not pp:
        return ""
    sig = pp + (
        ",".join(names)
        + f"|rec={e.get('INSPECTOR_PPOCR_REC', PPOCR_REC)}|det={e.get('INSPECTOR_PPOCR_DET', '')}"
        # вход детектора меняет прочтение: другая политика или потолок — другой ключ кэша (F08, T-232)
        + f"|side={DET_SCALE},{e.get('INSPECTOR_PPOCR_DET_FLOOR', str(DET_FLOOR))},{DET_MIN_SCALE},{DET_PIECE_OVERLAP}"
        + "|reading=regional-orientation-v3-wordbox-direction"
        + f"|cap={e.get('INSPECTOR_PPOCR_DET_LIMIT', '4096')},{e.get('INSPECTOR_PPOCR_GPU_MB', '6144')}|mpx={DET_MPX_PER_GB}"
    )
    return "-o" + hashlib.sha256(sig.encode()).hexdigest()[:8]


_BUILT: dict[tuple, list] = {}
_BUILT_LOCK = threading.Lock()


def configured_engines(profile: str | None = None, env: dict | None = None) -> list:
    """Экземпляры движков по конфигурации. Модели тяжёлые — экземпляры живут весь процесс (по ключу конфигурации)."""
    p = profile or (os.environ if env is None else env).get("INSPECTOR_PROFILE", "dev")
    names = engine_names(p, env)
    key = (p, names)
    with _BUILT_LOCK:
        if key not in _BUILT:
            _BUILT[key] = [FACTORIES[n](p) for n in names]
        return _BUILT[key]


def check_ready(profile: str, env: dict | None = None) -> list[str]:
    """Проверка при старте сервиса и этапа parse. В профиле gpu каждый движок обязан быть доступен —
    иначе OcrConfigError с причиной. В dev недоступный движок выбывает сам, как раньше."""
    engines = configured_engines(profile, env)
    if profile == "gpu":
        down = [
            f"{e.name} ({getattr(e, 'reason', '') or 'недоступен'})"
            for e in engines
            if not e.available()
        ]
        if down:
            raise OcrConfigError(
                f"OCR профиля gpu: недоступны {'; '.join(down)} — откат на CPU запрещён (OS-INSP-2.1.18)"
            )
    return [e.name for e in engines]


# ─────────────────────────────────────────────── ориентация страницы


@dataclass
class EngineReading:
    """Прочтение движка-якоря: слова (рамки — в кадре исходного изображения) и поворот текста."""

    words: list[Word]
    turns: int = 0  # четвертей оборота против часовой, после которых текст стоит прямо (0 — уже прямо)
    lines: list[list[Word]] = field(
        default_factory=list
    )  # те же слова по строкам движка


def turn_box(b: BBox, k: int) -> BBox:
    """Рамка в долях [0;1] после поворота изображения на k·90° против часовой (PIL rotate(90·k, expand=True))."""
    x0, y0, x1, y1 = b
    k %= 4
    if k == 1:  # (x, y) → (y, 1 − x)
        return (y0, 1 - x1, y1, 1 - x0)
    if k == 2:  # (x, y) → (1 − x, 1 − y)
        return (1 - x1, 1 - y1, 1 - x0, 1 - y0)
    if k == 3:  # (x, y) → (1 − y, x)
        return (1 - y1, x0, 1 - y0, x1)
    return b


def infer_turns(lines: list[list[Word]]) -> int:
    """Поворот текста по строкам якоря: большинство строк вертикальны → страница повёрнута на четверть оборота;
    направление — по порядку слов вдоль строки (сверху вниз → 1, снизу вверх → 3).
    Регион может содержать одну строку; отсутствие большинства или противоречие направлений → 0."""
    votes = {1: 0, 3: 0}
    horizontal = 0
    for ws in lines:
        boxes = [w.bbox for w in ws if w.bbox]
        if len(boxes) < 2:
            continue
        x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
        x1, y1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
        if (y1 - y0) < 1.5 * (x1 - x0):
            horizontal += 1
            continue
        first, last = (boxes[0][1] + boxes[0][3]) / 2, (boxes[-1][1] + boxes[-1][3]) / 2
        votes[1 if last > first else 3] += 1
    vertical = votes[1] + votes[3]
    if vertical <= horizontal or votes[1] == votes[3]:
        return 0
    return 1 if votes[1] >= votes[3] else 3


def group_lines_turned(
    words: list[Word], k: int, group: Callable[[list[Word]], list[Line]]
) -> list[Line]:
    """Строки повёрнутой страницы: группировка в кадре прямого текста, рамки слов остаются в исходном кадре."""
    if k % 4 == 0:
        return group(words)
    turned = [
        w.model_copy(update={"bbox": turn_box(w.bbox, k)}) if w.bbox else w
        for w in words
    ]
    back = {id(t): w for t, w in zip(turned, words)}
    return [
        Line(text=ln.text, words=[back[id(t)] for t in ln.words])
        for ln in group(turned)
    ]


# ─────────────────────────────────────────────── PP-OCR на GPU


def det_budget(arena_mb: int) -> float:
    """Пикселей входа детектора, которые помещаются в арену."""
    return arena_mb / 1024 * DET_MPX_PER_GB * 1e6


def det_side(width: int, height: int, cap: int, arena_mb: int, floor: int = DET_FLOOR) -> int:
    """Вход детектора (длинная сторона): доля DET_SCALE от листа, не больше cap и площади, помещающейся в арену,
    не меньше DET_FLOOR."""
    long, short = max(width, height), max(1, min(width, height))
    fit = int((det_budget(arena_mb) * long / short) ** 0.5)
    return max(floor, min(cap, fit, round(long * DET_SCALE)))


def det_pieces(
    width: int, height: int, cap: int, arena_mb: int
) -> list[tuple[tuple[int, int, int, int], tuple[int, int, int, int]]]:
    """Куски листа для детектора: (рамка куска, ядро). Лист, который детектор видит с долей не меньше DET_MIN_SCALE
    (по стороне cap и по площади арены), — один кусок. Иначе сетка кусков с перекрытием DET_PIECE_OVERLAP, каждый
    в тех же пределах; слово берётся из куска, в ядро которого попал его центр, — дублей на швах нет."""
    limit = int(cap / DET_MIN_SCALE)
    area = det_budget(arena_mb) / DET_MIN_SCALE**2  # пикселей листа на кусок

    def count(n: int) -> int:
        return (
            1
            if n <= limit
            else -(-(n - DET_PIECE_OVERLAP) // (limit - DET_PIECE_OVERLAP))
        )

    kx, ky = count(width), count(height)
    while (width / kx + DET_PIECE_OVERLAP) * (height / ky + DET_PIECE_OVERLAP) > area:
        if width / kx >= height / ky:
            kx += 1
        else:
            ky += 1

    def axis(n: int, k: int) -> list[tuple[int, int, int, int]]:
        if k == 1:
            return [(0, n, 0, n)]
        size = -(
            -(n + (k - 1) * DET_PIECE_OVERLAP) // k
        )  # куски равные, не длиннее limit
        spans = [
            (a, a + size)
            for a in (min(i * (size - DET_PIECE_OVERLAP), n - size) for i in range(k))
        ]
        cuts = (
            [0] + [(spans[i][1] + spans[i + 1][0]) // 2 for i in range(k - 1)] + [n]
        )  # середины перекрытий
        return [(a, b, cuts[i], cuts[i + 1]) for i, (a, b) in enumerate(spans)]

    return [
        ((x0, y0, x1, y1), (cx0, cy0, cx1, cy1))
        for (y0, y1, cy0, cy1) in axis(height, ky)
        for (x0, x1, cx0, cx1) in axis(width, kx)
    ]


def _quad_words(line_words, iw: int, ih: int) -> list[Word]:
    out = []
    for text, score, pts in line_words:
        t = nfc(str(text)).strip()
        if not t:
            continue
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        out.append(
            Word(
                text=t,
                bbox=(
                    round(min(max(min(xs) / iw, 0.0), 1.0), 5),
                    round(min(max(min(ys) / ih, 0.0), 1.0), 5),
                    round(min(max(max(xs) / iw, 0.0), 1.0), 5),
                    round(min(max(max(ys) / ih, 0.0), 1.0), 5),
                ),
                conf=round(float(score) * 100, 1),
            )
        )
    return out


def split_line(
    text: str, quad, score: float, iw: int, ih: int, *, reverse: bool = False
) -> list[tuple[str, float, list]]:
    """Запасной путь, когда движок не отдал рамки слов: рамка строки делится между словами пропорционально числу
    символов (пробел — один символ) вдоль длинной стороны строки."""
    words = text.split()
    if not words:
        return []
    xs, ys = [p[0] for p in quad], [p[1] for p in quad]
    x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
    vertical = (y1 - y0) > 1.5 * (x1 - x0)
    total = sum(len(w) for w in words) + len(words) - 1
    out, pos = [], 0
    for w in words:
        a, b = pos / total, (pos + len(w)) / total
        if reverse:
            a, b = 1-b, 1-a
        if vertical:
            box = [
                [x0, y0 + a * (y1 - y0)],
                [x1, y0 + a * (y1 - y0)],
                [x1, y0 + b * (y1 - y0)],
                [x0, y0 + b * (y1 - y0)],
            ]
        else:
            box = [
                [x0 + a * (x1 - x0), y0],
                [x0 + b * (x1 - x0), y0],
                [x0 + b * (x1 - x0), y1],
                [x0 + a * (x1 - x0), y1],
            ]
        out.append((w, score, box))
        pos += len(w) + 1
    return out


def merge_pieces(text: str, pieces) -> list[tuple[str, float, list]] | None:
    """Слова строки — по тексту строки, рамки — объединением кусков RapidOCR (return_word_box), которые
    покрывают буквы слова. RapidOCR режет по промежуткам между буквами: разрядка «П Р И Л О Ж Е Н И Е» давала
    куски «ПРИ», «ЛО», «Ж»… вместо одного слова строки. Буквы кусков не совпали с текстом строки — None
    (запасной путь — деление строки пропорционально, split_line)."""
    toks = text.split()
    flat = "".join(str(t).replace(" ", "") for t, _, _ in pieces)
    if not toks or flat != "".join(toks):
        return None
    owner = [k for k, (t, _, _) in enumerate(pieces) for _ in str(t).replace(" ", "")]
    out, pos = [], 0
    for tok in toks:
        ks = sorted(set(owner[pos : pos + len(tok)]))
        pos += len(tok)
        pts = [pt for k in ks for pt in pieces[k][2]]
        xs, ys = [q[0] for q in pts], [q[1] for q in pts]
        box = [
            [min(xs), min(ys)],
            [max(xs), min(ys)],
            [max(xs), max(ys)],
            [min(xs), max(ys)],
        ]
        out.append((tok, min(float(pieces[k][1]) for k in ks), box))
    return out


def orient_vertical_words(words, quad, reverse):
    """Correct a mirrored word-box axis only when it contradicts source direction."""
    if len(words) < 2:
        return words
    centre = lambda word: sum(p[1] for p in word[2])/len(word[2])
    first, last = centre(words[0]), centre(words[-1])
    if first == last or (last < first) == reverse:
        return words
    ys = [p[1] for p in quad]
    total = min(ys)+max(ys)
    return [(text,score,[[x,total-y] for x,y in box]) for text,score,box in words]


def _shrink_after_run(onnxruntime, stages) -> None:
    """Арена ONNX Runtime на видеокарте после каждого вызова отдаёт свободные блоки обратно. Без этого арены
    детектора, классификатора и распознавателя держат каждая свой пик, в сумме переполняя остаток видеокарты рядом
    с vLLM (замер T-184: страницы A1 падали по памяти только в общем прогоне)."""
    ro = onnxruntime.RunOptions()
    ro.add_run_config_entry("memory.enable_memory_arena_shrinkage", "gpu:0")
    for st in stages:
        sess = getattr(getattr(st, "session", None), "session", None)
        if sess is None:
            continue
        orig = sess.run
        sess.run = lambda names, feed, run_options=None, _o=orig: _o(
            names, feed, run_options or ro
        )


@dataclass
class PpOcrEngine:
    """PP-OCR (RapidOCR + ONNX Runtime). В профиле gpu доступен только на CUDA: сессия, упавшая на CPU, —
    «недоступен», а не медленный движок (onnxruntime сам молча уходит на CPU без библиотек CUDA)."""

    name: str
    det: str = PPOCR_DET  # v6-medium | v5-server | v5-mobile
    rec: str = PPOCR_REC  # eslav | cyrillic — распознаватель PP-OCRv5
    require_gpu: bool = True
    det_floor: int = DET_FLOOR
    det_limit: int = 4096  # потолок входа детектора (длинная сторона); сам вход — det_side(); распознавание — по кропам полного разрешения
    gpu_mem_mb: int = 6144  # потолок арены ONNX Runtime на экземпляр
    rec_batch: int = 32  # строк в одном вызове распознавателя
    fail_loud: bool = True  # сбой — ошибка разбора файла, а не пустая страница (ocr_ensemble.run_ensemble)
    streams: int = 1  # экземпляров на процесс (каждый — своя арена на видеокарте): параллельные страницы не ждут друг друга на CPU-частях конвейера
    # потоков ONNX Runtime на сессию: по умолчанию ORT берёт по потоку на ядро машины (32 × 3 сессии) — сотня потоков,
    # у каждого своя арена glibc, и маска ядер мимо taskset (T-230, утечка памяти этапа parse)
    threads: int = 2
    model_dir: str = ""  # каталог весов (INSPECTOR_PPOCR_MODEL_DIR); пусто — только dev (мак), в gpu — отказ
    reason: str = ""
    device: str = ""  # куда фактически ушли сессии: cuda | cpu
    _paths: dict | None = field(default=None, repr=False)
    _pool: "queue.Queue | None" = field(default=None, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def _params(self, use_cuda: bool) -> dict:
        from rapidocr import EngineType, LangDet, LangRec, ModelType, OCRVersion  # type: ignore[import-not-found]

        det = {
            "v5-server": (OCRVersion.PPOCRV5, ModelType.SERVER),
            "v5-mobile": (OCRVersion.PPOCRV5, ModelType.MOBILE),
            "v6-medium": (OCRVersion.PPOCRV6, ModelType.MEDIUM),
        }[self.det]
        ort = EngineType.ONNXRUNTIME
        return {
            "Global.max_side_len": 20000,  # без предварительного сжатия листа: мелкий шрифт штампа читается в полном dpi
            "Global.log_level": "warning",
            "Global.use_cls": True,  # строка вверх ногами (скан перевёрнут) — поворот на 180° до распознавания
            "EngineConfig.onnxruntime.use_cuda": use_cuda,
            "EngineConfig.onnxruntime.cuda_ep_cfg.gpu_mem_limit": self.gpu_mem_mb
            * 1024**2,
            "EngineConfig.onnxruntime.cuda_ep_cfg.cudnn_conv_algo_search": "HEURISTIC",
            "EngineConfig.onnxruntime.cuda_ep_cfg.arena_extend_strategy": "kSameAsRequested",
            "Det.engine_type": ort,
            "Cls.engine_type": ort,
            "Rec.engine_type": ort,
            "Det.ocr_version": det[0],
            "Det.model_type": det[1],
            "Det.lang_type": LangDet.CH,
            "Cls.ocr_version": OCRVersion.PPOCRV5,
            "Cls.model_type": ModelType.MOBILE,
            "Rec.ocr_version": OCRVersion.PPOCRV5,
            "Rec.model_type": ModelType.MOBILE,
            "Rec.lang_type": LangRec(self.rec),
            # строки страницы — пакетами: по 6 (умолчание RapidOCR) видеокарта простаивает между мелкими вызовами
            "Rec.rec_batch_num": self.rec_batch,
            "Cls.cls_batch_num": self.rec_batch,
            **self._model_paths(),
            **self._ort_threads(),
        }

    def _ort_threads(self) -> dict[str, int]:
        return {
            "EngineConfig.onnxruntime.intra_op_num_threads": self.threads,
            "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        }

    def _model_paths(self) -> dict[str, str]:
        """Локальные веса со сверкой хеша (один раз на экземпляр). Без каталога: в gpu — отказ, в dev — пусто
        (RapidOCR берёт свои веса, как раньше на маке)."""
        if self._paths is None:
            if self.model_dir:
                self._paths = local_model_paths(self.model_dir, self.det, self.rec)
            elif self.require_gpu:
                raise RuntimeError(
                    f"{MODEL_DIR_ENV} не задан — веса PP-OCR только из образа, загрузка в рантайме запрещена (OWASP-0211)"
                )
            else:
                self._paths = {}
        return self._paths

    def _new(self):
        self._model_paths()  # сверка весов до импорта и построения моделей: подмена — отказ без загрузки
        import onnxruntime  # type: ignore[import-not-found]
        from rapidocr import RapidOCR  # type: ignore[import-not-found]
        from rapidocr.ch_ppocr_det.utils import DetPreProcess  # type: ignore[import-not-found]

        # профиль gpu — только CUDA; dev — CUDA, если она есть (сервер с видеокартой), иначе CPU (мак)
        use_cuda = (
            self.require_gpu
            or "CUDAExecutionProvider" in onnxruntime.get_available_providers()
        )
        if use_cuda:
            try:
                onnxruntime.preload_dlls()  # библиотеки CUDA/cuDNN из колёс nvidia-* (onnxruntime-gpu[cuda,cudnn])
            except Exception as e:  # колёс nvidia-* нет — проверка провайдеров ниже скажет, куда ушла сессия
                log.warning("onnxruntime.preload_dlls: %s", e)
        eng = RapidOCR(params=self._params(use_cuda))
        td = eng.text_det
        # RapidOCR выбирает вход детектора сам (до 2000 по длинной стороне) и не слушает limit_side_len при «max»:
        # на 4090 рядом с vLLM это переполняло арену. Потолок задаём явно.
        td.get_preprocess = lambda max_wh: DetPreProcess(
            getattr(td, "inspector_side", self.det_cap()), "max", td.mean, td.std
        )
        if use_cuda:
            _shrink_after_run(
                onnxruntime, [td, eng.text_rec, getattr(eng, "text_cls", None)]
            )
        got = {
            td.session.session.get_providers()[0],
            eng.text_rec.session.session.get_providers()[0],
        }
        if use_cuda and got != {"CUDAExecutionProvider"}:
            if self.require_gpu:
                raise RuntimeError(f"ONNX Runtime без CUDA: {sorted(got)}")
            log.warning("%s: CUDA есть, но сессии ушли на %s", self.name, sorted(got))
        self.device = "cuda" if got == {"CUDAExecutionProvider"} else "cpu"
        return eng

    def available(self) -> bool:
        with self._lock:
            if self._pool is not None:
                return True
            try:
                pool: queue.Queue = queue.Queue()
                for _ in range(max(1, self.streams)):
                    pool.put(self._new())
            except (
                Exception
            ) as e:  # нет пакета, нет CUDA, нет модели — причина уходит в ошибку старта
                self.reason = f"{type(e).__name__}: {e}"[:300]
                return False
            self._pool = pool
            return True

    def det_cap(self) -> int:
        return max(self.det_floor, min(self.det_limit, self.gpu_mem_mb))

    def read_page(self, image: Image.Image) -> EngineReading:
        if not self.available():
            raise RuntimeError(f"{self.name}: {self.reason}")
        cap = self.det_cap()
        pieces = det_pieces(*image.size, cap, self.gpu_mem_mb)
        if len(pieces) == 1:
            return self._read_lines(image, det_side(*image.size, cap, self.gpu_mem_mb, self.det_floor))
        lines: list[list[Word]] = []
        iw, ih = image.size
        for piece, core in pieces:
            x0, y0, x1, y1 = piece
            crop = image.crop(piece)
            r = self._read_lines(crop, det_side(*crop.size, cap, self.gpu_mem_mb, self.det_floor))
            for ln in r.lines:
                kept = []
                for w in ln:
                    b = w.bbox  # доли куска → доли листа
                    fb = (
                        (x0 + b[0] * (x1 - x0)) / iw,
                        (y0 + b[1] * (y1 - y0)) / ih,
                        (x0 + b[2] * (x1 - x0)) / iw,
                        (y0 + b[3] * (y1 - y0)) / ih,
                    )
                    # центр в px листа, округлённый: слово ровно на разрезе из двух кусков даёт одно и то же число
                    cx, cy = (
                        round((fb[0] + fb[2]) / 2 * iw, 2),
                        round((fb[1] + fb[3]) / 2 * ih, 2),
                    )
                    if core[0] <= cx < core[2] and core[1] <= cy < core[3]:
                        kept.append(
                            w.model_copy(
                                update={"bbox": tuple(round(v, 5) for v in fb)}
                            )
                        )
                if kept:
                    lines.append(kept)
        return EngineReading(
            words=[w for ws in lines for w in ws], turns=infer_turns(lines), lines=lines
        )

    def _read_lines(self, image: Image.Image, side: int) -> EngineReading:
        assert self._pool is not None
        arr = np.asarray(image.convert("RGB"))[
            :, :, ::-1
        ].copy()  # RapidOCR ждёт BGR, как OpenCV
        eng = self._pool.get()
        try:
            eng.text_det.inspector_side = (
                side  # экземпляр из пула — только у этого вызова
            )
            r = eng(arr, return_word_box=True)
        finally:
            self._pool.put(eng)
        iw, ih = image.size
        lines: list[list[Word]] = []
        per_line = getattr(r, "word_results", None) or ()
        for i, text in enumerate(r.txts or ()):
            lw = per_line[i] if i < len(per_line) and per_line[i] else None
            lw = merge_pieces(str(text), lw) if lw else None
            quad = np.asarray(r.boxes[i]).tolist()
            xs, ys = [p[0] for p in quad], [p[1] for p in quad]
            reverse = False
            if max(ys)-min(ys) > 1.5*(max(xs)-min(xs)):
                # Pinned RapidOCR word boxes can omit the classifier's 180°
                # correction. Check source direction for both real boxes and
                # proportional fallback, without changing text or word order.
                from rapidocr.utils.process_img import get_rotate_crop_image
                from .resource_scope import render_guarded
                crop = render_guarded(lambda: get_rotate_crop_image(arr, np.asarray(quad,dtype=np.float32)),
                                      max(xs)-min(xs), max(ys)-min(ys), 1)
                classifier_engine = self._pool.get()
                try:
                    classified = classifier_engine.text_cls([crop])
                    angle, confidence = classified.cls_res[0]
                    reverse = str(angle) == '180' and float(confidence) > float(classifier_engine.text_cls.cls_thresh)
                finally:
                    self._pool.put(classifier_engine)
                    del crop
                if lw:
                    lw = orient_vertical_words(lw, quad, reverse)
            if not lw:
                lw = split_line(str(text), quad, float(r.scores[i]), iw, ih, reverse=reverse)
            ws = _quad_words(lw, iw, ih)
            if ws:
                lines.append(ws)
        return EngineReading(
            words=[w for ws in lines for w in ws], turns=infer_turns(lines), lines=lines
        )

    def read(self, image: Image.Image) -> list[Word]:
        return self.read_page(image).words


# ─────────────────────────────────────────────── читатель VL — второй голос по строкам якоря


def tokens(text: str) -> list[str]:
    return [t for t in nfc(text).replace("\n", " ").split() if t]


def align_tokens(
    anchor: list[Word], read: list[str], key: Callable[[str], str]
) -> list[Word]:
    """Выравнивание прочтения строки со словами якоря (последовательности ключей сравнения, difflib).

    - совпавшие и заменённые 1:1 слова получают рамку слова якоря;
    - замена неравной длины: токены прочтения раскладываются по словам якоря пропорционально позиции символа,
      токены, попавшие на одно слово, склеиваются (якорь видел одно слово там, где читатель — два, и наоборот);
    - лишние токены прочтения (без слова якоря) отбрасываются: у них нет рамки, а выдумать её нельзя;
    - слово якоря без пары остаётся без голоса читателя."""
    a_keys, r_keys = [key(w.text) for w in anchor], [key(t) for t in read]
    out: list[Word] = []
    sm = difflib.SequenceMatcher(a=a_keys, b=r_keys, autojunk=False)
    for op, i0, i1, j0, j1 in sm.get_opcodes():
        if op == "equal" or (op == "replace" and i1 - i0 == j1 - j0):
            for i, j in zip(range(i0, i1), range(j0, j1)):
                out.append(Word(text=read[j], bbox=anchor[i].bbox, conf=VL_CONF))
        elif op == "replace":
            span = anchor[i0:i1]
            lens = [max(len(w.text), 1) for w in span]
            total = sum(lens)
            edges, acc = [], 0
            for n in lens:
                edges.append((acc / total, (acc + n) / total))
                acc += n
            rt = read[j0:j1]
            r_total = sum(max(len(t), 1) for t in rt)
            buckets: dict[int, list[str]] = {}
            pos = 0
            for t in rt:
                mid = (pos + max(len(t), 1) / 2) / r_total
                pos += max(len(t), 1)
                idx = next(
                    (k for k, (lo, hi) in enumerate(edges) if lo <= mid < hi),
                    len(span) - 1,
                )
                buckets.setdefault(idx, []).append(t)
            for idx in sorted(buckets):
                out.append(
                    Word(text="".join(buckets[idx]), bbox=span[idx].bbox, conf=VL_CONF)
                )
    return out


def _to_px(
    b: BBox, iw: int, ih: int, pad_x: float, pad_y: float
) -> tuple[int, int, int, int]:
    w, h = (b[2] - b[0]) * iw, (b[3] - b[1]) * ih
    return (
        max(0, int(b[0] * iw - pad_x * w - 2)),
        max(0, int(b[1] * ih - pad_y * h - 2)),
        min(iw, int(b[2] * iw + pad_x * w + 2) + 1),
        min(ih, int(b[3] * ih + pad_y * h + 2) + 1),
    )


# Кроп строки больше этого — не строка (якорь склеил слова через весь лист): читатель на нём генерирует до лимита
# токенов по 16 с на запрос (T-232, лист 1,5 м — 35 с на одну «строку»). Обычная строка — 0,05–0,3 Мп.
VL_MAX_CROP_PX = 2_000_000
# T-233: запросов к читателю одновременно на весь процесс ML (страницы × потоки строк иначе давали сотни ожидающих:
# vLLM рвал соединения, и голосование VL пропадало у целых страниц). Процессов ML n — на vLLM приходит n × предел.
VL_INFLIGHT = threading.BoundedSemaphore(int(os.environ.get("INSPECTOR_VL_INFLIGHT", "24") or 24))
VL_RETRIES = 3  # повторов одной строки при обрыве соединения / ответе 5xx; 4xx — не повторяется (запрос неверный)


def line_crop(image: Image.Image, words: list[Word], turns: int) -> Image.Image:
    """Кроп строки якоря (рамки — исходный кадр) с полями; повёрнутый текст ставится прямо."""
    boxes = [w.bbox for w in words if w.bbox]
    b = (
        min(x[0] for x in boxes),
        min(x[1] for x in boxes),
        max(x[2] for x in boxes),
        max(x[3] for x in boxes),
    )
    k = turns % 4
    # поля: поперёк строки — 25 % высоты, вдоль — 2 %; для вертикальной строки оси меняются местами
    px, py = (0.02, 0.25) if k in (0, 2) else (0.25, 0.02)
    crop = image.crop(_to_px(b, *image.size, px, py))
    return crop.rotate(90 * k, expand=True) if k else crop


@dataclass
class VlLineReader:
    """PaddleOCR-VL через vLLM: голос за текст слов в рамках строк якоря (PP-OCR)."""

    name: str
    require: bool = True
    concurrency: int = (
        32  # параллельных запросов со страницы: vLLM собирает их в пакет (max-num-seqs)
    )
    band_lines: int = 1  # строк якоря в одном запросе: полоса из N строк — в N раз меньше запросов к vLLM
    needs_anchor: bool = True
    reason: str = ""
    generate: Callable[[Image.Image, int], str] | None = (
        None  # подмена в тестах; иначе vlm.generate(READER, …)
    )

    def available(self) -> bool:
        if self.generate is not None:
            return True
        from . import vlm

        try:
            if vlm.backend() != "openai":
                self.reason = "INSPECTOR_VLM_BACKEND должен быть openai (vLLM)"
                return False
            url = vlm.check_vlm_url(os.environ.get("INSPECTOR_VLM_URL", ""))
            with urllib.request.urlopen(url + "/models", timeout=10) as r:  # noqa: S310 — адрес задаёт конфигурация
                ids = [m.get("id") for m in json.loads(r.read()).get("data", [])]
        except Exception as e:  # сервер не поднят, адрес не тот
            self.reason = f"{type(e).__name__}: {e}"[:300]
            return False
        if vlm.READER not in ids:
            self.reason = (
                f"vLLM не отдаёт модель {vlm.READER} (есть: {', '.join(map(str, ids))})"
            )
            return False
        return True

    def _ask(self, crop: Image.Image, max_tokens: int) -> str:
        if self.generate is not None:
            return self.generate(crop, max_tokens)
        from . import vlm

        # A single anchor row is a single-line OCR task. Do not let the
        # model continue inventing repeated rule/underline rows after it.
        return vlm.generate(vlm.READER, crop, VL_PROMPT, max_tokens=max_tokens,
                            stop=["\n"] if self.band_lines == 1 else None)

    def _ask_line(self, crop: Image.Image, max_tokens: int) -> str | None:
        """Запрос читателю с повторами. Обрыв соединения и 5xx — повтор с паузой; 4xx (плохой кроп) и исчерпанные
        повторы — None: воздержание по этой строке, а не выбывание читателя со всей страницы (T-233)."""
        import time
        import urllib.error

        last: Exception | None = None
        for attempt in range(VL_RETRIES + 1):
            try:
                with VL_INFLIGHT:
                    return self._ask(crop, max_tokens)
            except urllib.error.HTTPError as e:
                if e.code < 500:
                    log.warning("vl-reader: строка пропущена, HTTP %s", e.code)
                    return None
                last = e
            except (OSError, urllib.error.URLError) as e:  # обрыв, сброс соединения, тайм-аут
                last = e
            time.sleep(min(0.5 * 2**attempt, 4.0))
        log.warning("vl-reader: строка пропущена после %s повторов: %s", VL_RETRIES, last)
        return None

    def read_with(
        self,
        image: Image.Image,
        anchor: list[Word],
        turns: int,
        key: Callable[[str], str],
        group: Callable[[list[Word]], list[Line]],
    ) -> list[Word]:
        rows = [
            ln.words
            for ln in group_lines_turned([w for w in anchor if w.bbox], turns, group)
        ]
        # полоса подряд идущих строк читается одним запросом; прочтение полосы выравнивается со словами всех её
        # строк в порядке чтения — выравнивание последовательностей не зависит от того, где читатель разбил строки
        n = max(1, self.band_lines)
        lines = [
            [w for r in rows[i : i + n] for w in r] for i in range(0, len(rows), n)
        ]

        def one(item) -> list[Word]:
            index, ws = item
            text = " ".join(w.text for w in ws)
            crop = line_crop(image, ws, turns)
            if crop.width * crop.height > VL_MAX_CROP_PX:
                failures.append(f"band:{index}:crop_limit")
                return []  # воздержание: слова остаются за якорем
            # A short PP-OCR anchor may miss part of the visible band. A 48-token
            # cap truncated a real synthetic release probe before EOS. Allow
            # a bounded floor; completed_text and hallucination checks still
            # reject truncated or implausible output without another call.
            got = self._ask_line(crop, min(2048, max(256, 16 + 2 * len(text))))
            if got is None:
                dead.append(1)
                failures.append(f"band:{index}:reader_unavailable")
                return []  # воздержание по строке: слова остаются за якорем, страница не теряет голосование целиком
            toks = tokens(got)
            # галлюцинация (повтор, чужой текст): прочтение втрое длиннее строки якоря — читатель воздерживается
            if len(" ".join(toks)) > 3 * len(text) + 10:
                failures.append(f"band:{index}:rejected_transcription")
                return []
            return align_tokens(ws, toks, key)

        dead: list[int] = []
        failures: list[str] = []
        with ThreadPoolExecutor(
            max_workers=max(1, min(self.concurrency, len(lines) or 1))
        ) as ex:
            from .execution_scope import scoped_submit
            futures = [scoped_submit(ex, one, item) for item in enumerate(lines)]
            out = [w for future in futures for w in future.result()]
        if lines and len(dead) == len(lines):
            # ни одна строка страницы не прочитана — читатель недоступен, а не воздержался: выбывает, как раньше
            raise RuntimeError(f"{self.name}: читатель не ответил ни по одной строке страницы")
        return ReaderWords(out, failures)

    def read(self, image: Image.Image) -> list[Word]:  # без якоря голосовать нечем
        raise RuntimeError(
            f"{self.name}: читатель VL работает только по строкам якоря PP-OCR"
        )


# ─────────────────────────────────────────────── реестр имён


def _tesseract(name: str, psm: str, prep: bool) -> Callable[[str], object]:
    def make(profile: str):
        from .ocr_ensemble import TesseractEngine

        return TesseractEngine(name, psm=psm, preprocessed=prep)

    return make


def _env_int(name: str, default: int, lo: int, hi: int, env: dict | None = None) -> int:
    try:
        return min(
            max(int((os.environ if env is None else env).get(name, default)), lo), hi
        )
    except ValueError:
        return default


def _ppocr(name: str, det: str, profile: str, env: dict | None = None) -> PpOcrEngine:
    """PP-OCR с параметрами стенда: память арены и вход детектора — под соседей на видеокарте (vLLM)."""
    e = os.environ if env is None else env
    return PpOcrEngine(
        name,
        det=e.get("INSPECTOR_PPOCR_DET", det),
        model_dir=e.get(MODEL_DIR_ENV, ""),
        threads=_env_int("INSPECTOR_PPOCR_THREADS", 2, 1, 16, env),
        require_gpu=profile == "gpu",
        det_floor=_env_int("INSPECTOR_PPOCR_DET_FLOOR", DET_FLOOR, 640, DET_FLOOR, env),
        det_limit=_env_int("INSPECTOR_PPOCR_DET_LIMIT", 4096, 640, 4096, env),
        gpu_mem_mb=_env_int("INSPECTOR_PPOCR_GPU_MB", 6144, 256, 16384, env),
        streams=_env_int("INSPECTOR_PPOCR_STREAMS", 1, 1, 8, env),
        rec_batch=_env_int("INSPECTOR_PPOCR_REC_BATCH", 32, 1, 256, env),
    )


FACTORIES: dict[str, Callable[[str], object]] = {
    "tesseract-psm4": _tesseract("tesseract-psm4", "4", False),
    "tesseract-prep": _tesseract("tesseract-prep", "4", True),
    "tesseract-psm6": _tesseract("tesseract-psm6", "6", False),
    "ppocr-v5": lambda p: _ppocr("ppocr-v5", PPOCR_DET, p),
    "ppocr-v5m": lambda p: _ppocr("ppocr-v5m", "v5-mobile", p),
    "ppocr-v6det": lambda p: _ppocr("ppocr-v6det", "v6-medium", p),
    "vl-reader": lambda p: VlLineReader(
        "vl-reader",
        require=p == "gpu",
        band_lines=_env_int("INSPECTOR_VL_BAND_LINES", 1, 1, 64),
        concurrency=_env_int("INSPECTOR_VL_CONCURRENCY", 32, 1, 256),
    ),
}
