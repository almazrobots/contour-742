"""Читатели сканов — локальные VLM по полосам листа (PRM-14; OS-INSP-2.1.13, 2.2.18–2.2.20; T-130).

Зачем. Ансамбль Tesseract на плохом скане искажает оборот («Со» вместо «С0») или теряет строки: на «Алтуфьевском 79Б»
сканы КР и ПБ 2024 распознаны с уверенностью 37–44 %. VLM читает по изображению иначе и ошибается в других местах —
третье, независимое прочтение.

Как устроено (одна модель — один процесс, опыт T-129: две VLM в одном процессе дали своп 9 ГБ):
- этап reader (python -m inspector_ml.stages reader): страницы без текстового слоя, где ансамбль дал низкое качество
  или в тексте есть нечёткий след оборота параметра-класса, читаются PaddleOCR-VL полосами → кэш прочтений;
- этап reader2 (другой процесс, GLM-OCR — другое семейство, ошибки не коррелируют): только спорные места — ансамбль и
  читатель разошлись в значении, или упоминание нашёл один читатель → кроп области → кэш;
- сервис разбора (app.analyze) сводит готовые прочтения с упоминаниями ансамбля (merge_page) и моделей читателей не
  загружает: прочтений нет — упоминания ансамбля остаются как есть.

У прочтения VLM нет координат: место упоминания берётся по словам ансамбля в той же полосе листа, а не найдя — рамкой
полосы. Значение от читателей принимается, только если его подтвердили два прочтения из трёх (как перечитывание 2.2.12):
ложная находка для надзора хуже пропуска.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from rapidfuzz import fuzz

from .class_mentions import _page_mentions, normalize_class
from .model import BBox, Extraction, Line, Page, ParamSpec, ParsedDoc, Word

BANDS = 4  # полос на лист: VLM с ограниченным числом токенов не дочитывает плотный лист целиком
OVERLAP = (
    0.04  # перекрытие полос (доля высоты листа): строка на границе полос не теряется
)
READ_DPI = 150  # растр для читателя: замер T-129 (PaddleOCR-VL, полоса текста при 150 dpi — 6,7 с)
TRACE_MIN = 75  # нечёткое совпадение следа оборота с текстом ансамбля, 0–100 (rapidfuzz partial_ratio)
LOCATE_MIN = (
    60  # совпадение следа оборота со строкой ансамбля, чтобы взять её место на листе
)
MATCH_MIN = 50  # сходство цитат (короткая внутри длинной: у ансамбля цитата со всей страницы, у читателя — из полосы)
CONFIRMED_CONF = 0.75  # два прочтения из трёх согласны — как CONF_BY_AGREE[2] перечитывания (reread.py)
DISPUTED_FACTOR = 0.6  # большинства нет — как штраф сомнительного слова (class_mentions.DISPUTED_PENALTY)
UNCONFIRMED = "READER_UNCONFIRMED"
UNCONFIRMED_WHY = (
    "упоминание нашёл только читатель сканов, второе прочтение его не подтвердило"
)


@dataclass(frozen=True)
class Band:
    y0: float
    y1: float
    text: str


def band_ranges(n: int = BANDS, overlap: float = OVERLAP) -> list[tuple[float, float]]:
    """Горизонтальные полосы листа в долях высоты [0;1] с перекрытием."""
    h = 1 / n
    return [
        (round(max(0.0, i * h - overlap), 4), round(min(1.0, (i + 1) * h + overlap), 4))
        for i in range(n)
    ]


def trace_phrase(cfg: dict) -> str:
    """След оборота для нечёткого поиска — буквенные основы якоря: «конструктивн\\w*\\s+пожарн…» → «конструктивн пожарн опасност»."""
    stems = [
        w
        for w in re.findall(
            r"[А-Яа-яЁёA-Za-z]+", re.sub(r"\\[a-zA-Z]", " ", cfg.get("anchor", ""))
        )
        if len(w) >= 3
    ]
    return " ".join(stems).lower()


def _page_plain(page: Page) -> str:
    return " ".join(ln.text for ln in page.lines).lower()


def has_trace(page: Page, phrase: str, min_score: int = TRACE_MIN) -> bool:
    """В тексте страницы есть нечёткий след оборота: ансамбль мог исказить буквы, но не всю фразу."""
    return bool(phrase) and fuzz.partial_ratio(phrase, _page_plain(page)) >= min_score


def reader_pages(doc: ParsedDoc, cfgs: list[dict]) -> list[int]:
    """Страницы для читателя (OS-INSP-2.1.13): скан, где ансамбль не уверен (LOW_QUALITY, ABSTAIN), или со следом оборота."""
    phrases = [p for p in (trace_phrase(c) for c in cfgs) if p]
    out = []
    for page in doc.pages:
        if page.source != "ocr":
            continue
        if page.quality != "OK" or any(has_trace(page, ph) for ph in phrases):
            out.append(page.page)
    return out


# ─────────────────────────────────────────────── кэш прочтений


def _slug(model: str) -> str:
    return re.sub(r"[^A-Za-z0-9.]+", "_", model.split("/")[-1])


def box_key(box: BBox) -> str:
    return "_".join(f"{v:.3f}" for v in box)


class ReaderCache:
    """Прочтения читателей на диске: <root>/<sha>/p<стр>-<модель>.json (полосы) и c<стр>-<рамка>-<модель>.json (кроп).
    Запись атомарная (временный файл → rename): сервис разбора может читать кэш, пока этап пишет."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)

    def _dir(self, sha: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{64}", sha):
            raise ValueError("sha256: ждём 64 hex-символа")
        return self.root / sha

    def _write(self, path: Path, data: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False))
        tmp.replace(path)

    def _read(self, path: Path) -> dict | None:
        try:
            return json.loads(path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def get_page(self, sha: str, page: int, model: str) -> list[Band] | None:
        d = self._read(self._dir(sha) / f"p{page}-{_slug(model)}.json")
        return [Band(b["y0"], b["y1"], b["text"]) for b in d["bands"]] if d else None

    def put_page(
        self, sha: str, page: int, model: str, bands: list[Band], ms: int
    ) -> None:
        self._write(
            self._dir(sha) / f"p{page}-{_slug(model)}.json",
            {"model": model, "ms": ms, "bands": [b.__dict__ for b in bands]},
        )

    def get_crop(self, sha: str, page: int, box: BBox, model: str) -> str | None:
        d = self._read(self._dir(sha) / f"c{page}-{box_key(box)}-{_slug(model)}.json")
        return d["text"] if d else None

    def put_crop(
        self, sha: str, page: int, box: BBox, model: str, text: str, ms: int
    ) -> None:
        self._write(
            self._dir(sha) / f"c{page}-{box_key(box)}-{_slug(model)}.json",
            {"model": model, "ms": ms, "text": text},
        )

    def signature(self, sha: str) -> str:
        """Отпечаток прочтений файла для ключа кэша разбора: новое прочтение — новый результат, а не старый из кэша."""
        d = self._dir(sha)
        if not d.is_dir():
            return ""
        h = hashlib.sha256()
        for f in sorted(d.glob("*.json")):
            h.update(f.name.encode())
            h.update(f.read_bytes())
        return h.hexdigest()[:12]


# ─────────────────────────────────────────────── сведение прочтений


def band_page(band: Band, number: int) -> Page:
    """Прочтение полосы как страница без координат: те же правила поиска упоминаний, что у ансамбля."""
    lines = [
        Line(text=t, words=[Word(text=w) for w in t.split()])
        for t in (s.strip() for s in band.text.splitlines())
        if t
    ]
    return Page(
        page=number, width=0, height=0, source="ocr", ocr_confidence=100.0, lines=lines
    )


def band_mentions(
    bands: list[Band], number: int, spec: ParamSpec
) -> list[tuple[Band, Extraction]]:
    """Упоминания в прочтении читателя; повтор в перекрытии соседних полос — одно упоминание, а его полоса — объединение
    обеих: строка на границе лежит в обеих полосах, и упоминание ансамбля ищется во всём этом диапазоне."""
    out: list[tuple[Band, Extraction]] = []
    for b in bands:
        for m in _page_mentions(band_page(b, number), spec, spec.extractor or {}):
            q = _norm(m.meta["quote"])
            dup = next(
                (
                    i
                    for i, (_, o) in enumerate(out)
                    if o.value_text == m.value_text
                    and fuzz.partial_ratio(_norm(o.meta["quote"]), q) >= 90
                ),
                None,
            )
            if dup is None:
                out.append((b, m))
                continue
            ob, om = out[dup]
            out[dup] = (Band(min(ob.y0, b.y0), max(ob.y1, b.y1), ob.text), om)
    return out


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.lower()).strip()


def _yc(box: BBox | None) -> float | None:
    return None if box is None else (box[1] + box[3]) / 2


def mention_area(ex: Extraction) -> BBox | None:
    """Охват якоря и значения упоминания ансамбля — область, которую читает второй читатель."""
    boxes = [b for b in (ex.anchor_bbox, ex.bbox) if b]
    if not boxes:
        return None
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def locate(page: Page, band: Band, phrase: str) -> BBox | None:
    """Место упоминания, найденного читателем: строка ансамбля в той же полосе, лучше всех похожая на след оборота."""
    best, score = None, LOCATE_MIN - 1
    for ln in page.lines:
        boxes = [w.bbox for w in ln.words if w.bbox]
        if not boxes:
            continue
        yc = sum((b[1] + b[3]) / 2 for b in boxes) / len(boxes)
        if not band.y0 <= yc <= band.y1:
            continue
        s = fuzz.partial_ratio(phrase, ln.text.lower())
        if s > score:
            best, score = boxes, s
    if best is None:
        return None
    return (
        min(b[0] for b in best),
        min(b[1] for b in best),
        max(b[2] for b in best),
        max(b[3] for b in best),
    )


def second_value(text: str | None, spec: ParamSpec) -> str | None:
    """Значение из прочтения второго читателя: упоминание по правилам, иначе единственный класс шкалы в тексте."""
    if not text:
        return None
    cfg = spec.extractor or {}
    page = band_page(Band(0.0, 1.0, text), 1)
    found = {m.value_text for m in _page_mentions(page, spec, cfg)}
    if not found:
        scale = cfg.get("scale")
        found = {
            normalize_class(m.group(0))
            for m in re.finditer(cfg.get("value", r"(?!x)x"), text)
        }
        if scale is not None:
            found &= set(scale)
    return found.pop() if len(found) == 1 else None


@dataclass(frozen=True)
class Models:
    """Подписи прочтений для карточки инспектора."""

    ensemble: str
    reader: str
    reader2: str


def _reading(by: str, value: str | None) -> dict:
    return {"by": by, "value": value}


def merge_page(
    page: Page,
    ensemble: list[Extraction],
    reader: list[tuple[Band, Extraction]],
    spec: ParamSpec,
    crop_text: Callable[[BBox], str | None],
    models: Models,
) -> list[Extraction]:
    """Свести упоминания класса одной страницы-скана: ансамбль OCR + читатель (+ второй читатель по спорным местам).

    Чистая функция: вход не меняется; второй читатель спрашивается через crop_text (кэш или модель). OS-INSP-2.2.18–2.2.20.
    """
    phrase = trace_phrase(spec.extractor or {})
    used: set[int] = set()
    out: list[Extraction] = []
    for t in ensemble:
        meta = dict(t.meta or {})
        meta["text_source"] = "scan-ocr"
        yc = _yc(mention_area(t))
        best, best_s = -1, MATCH_MIN - 1
        for i, (b, r) in enumerate(reader):
            if i in used or yc is None or not b.y0 <= yc <= b.y1:
                continue
            s = fuzz.partial_ratio(_norm(t.meta["quote"]), _norm(r.meta["quote"]))
            if s > best_s:
                best, best_s = i, s
        if best < 0:
            meta["readings"] = [
                _reading(models.ensemble, t.value_text),
                _reading(models.reader, None),
            ]
            meta["reader_outcome"] = "ensemble-only"
            out.append(t.model_copy(update={"meta": meta}))
            continue
        used.add(best)
        r = reader[best][1]
        if r.value_text == t.value_text:
            meta["readings"] = [
                _reading(models.ensemble, t.value_text),
                _reading(models.reader, r.value_text),
            ]
            meta["reader_outcome"] = "agree"
            meta["ops"] = list(dict.fromkeys([*(meta.get("ops") or []), "PRM-14"]))
            out.append(t.model_copy(update={"meta": meta}))
            continue
        area = mention_area(t)
        v2 = second_value(crop_text(area), spec) if area else None
        meta["readings"] = [
            _reading(models.ensemble, t.value_text),
            _reading(models.reader, r.value_text),
            _reading(models.reader2, v2),
        ]
        meta["ops"] = list(dict.fromkeys([*(meta.get("ops") or []), "PRM-14"]))
        upd: dict = {"meta": meta}
        if v2 is not None and v2 == r.value_text:
            # два прочтения из трёх — за читателя: значение и его ограничение «не ниже» берутся из прочтения читателя
            meta["reader_outcome"] = "majority-reader"
            meta["qualifier"] = (r.meta or {}).get("qualifier")
            # уверенность — по числу согласных прочтений (2 из 3), а не прежняя уверенность ансамбля в неверном значении
            upd.update(value_text=r.value_text, raw=r.raw, confidence=CONFIRMED_CONF)
        elif v2 is not None and v2 == t.value_text:
            meta["reader_outcome"] = "majority-ensemble"
        else:
            meta["reader_outcome"] = "no-majority"
            upd["confidence"] = round(t.confidence * DISPUTED_FACTOR, 3)
        out.append(t.model_copy(update=upd))
    for i, (b, r) in enumerate(reader):
        if i in used:
            continue
        box = locate(page, b, phrase) or (0.0, b.y0, 1.0, b.y1)
        meta = dict(r.meta or {})
        meta["text_source"] = "scan-reader"
        meta["ops"] = list(dict.fromkeys([*(meta.get("ops") or []), "PRM-14"]))
        meta["located"] = "line" if box[0] > 0.0 or box[2] < 1.0 else "band"
        if meta.get("excluded"):
            # отсеяно правилами (соседнее здание, норма) — второй читатель не нужен, причина остаётся
            meta["readings"] = [
                _reading(models.ensemble, None),
                _reading(models.reader, r.value_text),
            ]
            meta["reader_outcome"] = "reader-only"
            out.append(
                r.model_copy(
                    update={
                        "meta": meta,
                        "page": page.page,
                        "bbox": box,
                        "anchor_bbox": None,
                    }
                )
            )
            continue
        v2 = second_value(crop_text(box), spec)
        meta["readings"] = [
            _reading(models.ensemble, None),
            _reading(models.reader, r.value_text),
            _reading(models.reader2, v2),
        ]
        conf = CONFIRMED_CONF
        if v2 == r.value_text:
            meta["reader_outcome"] = "reader-only-confirmed"
        else:
            meta["reader_outcome"] = "reader-only-unconfirmed"
            meta.update(excluded=UNCONFIRMED, excluded_why=UNCONFIRMED_WHY)
            conf = round(CONFIRMED_CONF * DISPUTED_FACTOR, 3)
        out.append(
            r.model_copy(
                update={
                    "meta": meta,
                    "page": page.page,
                    "bbox": box,
                    "anchor_bbox": None,
                    "confidence": conf,
                }
            )
        )
    return out


def tag_text_source(
    doc: ParsedDoc, extractions: list[Extraction], codes: set[str]
) -> list[Extraction]:
    """OS-INSP-2.2.20: у каждого упоминания класса — источник текста (текстовый слой PDF или распознавание скана)."""
    kind = {
        p.page: (
            "pdf-text"
            if p.source == "text"
            else "scan-ocr"
            if p.source == "ocr"
            else "structured"
        )
        for p in doc.pages
    }
    out = []
    for e in extractions:
        if e.code in codes and not (e.meta or {}).get("text_source"):
            meta = dict(e.meta or {})
            meta["text_source"] = kind.get(e.page, "structured")
            e = e.model_copy(update={"meta": meta})
        out.append(e)
    return out


def merge_doc(
    sha: str,
    doc: ParsedDoc,
    extractions: list[Extraction],
    specs: list[ParamSpec],
    cache: ReaderCache | None,
    models: Models,
    crop_text: Callable[[int, BBox], str | None] | None = None,
) -> list[Extraction]:
    """Свести прочтения читателей со всеми упоминаниями классов документа. Нет кэша или прочтений страницы — как было.
    crop_text(страница, рамка) — второй читатель; по умолчанию только кэш (сервис разбора моделей читателей не грузит)."""
    specs = [s for s in specs if (s.extractor or {}).get("kind") == "class_mentions"]
    codes = {s.code for s in specs}
    if cache is None or not specs:
        return tag_text_source(doc, extractions, codes)
    ask = crop_text or (lambda n, box: cache.get_crop(sha, n, box, models.reader2))
    pages = {p.page: p for p in doc.pages}
    merged: dict[tuple[str, int], list[Extraction]] = {}
    for spec in specs:
        for n, page in pages.items():
            if page.source != "ocr":
                continue
            bands = cache.get_page(sha, n, models.reader)
            if bands is None:
                continue
            ens = [e for e in extractions if e.code == spec.code and e.page == n]
            merged[(spec.code, n)] = merge_page(
                page,
                ens,
                band_mentions(bands, n, spec),
                spec,
                lambda box, n=n: ask(n, box),
                models,
            )
    out: list[Extraction] = []
    done: set[tuple[str, int]] = set()
    for e in extractions:
        k = (e.code, e.page)
        if k in merged:
            if k not in done:
                out += merged[k]
                done.add(k)
            continue
        out.append(e)
    for k, v in merged.items():
        if k not in done:
            out += v  # страница, где ансамбль ничего не нашёл, а читатель — нашёл
    return tag_text_source(doc, out, codes)
