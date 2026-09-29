"""Перечень скрытых работ из Общих данных ПД/РД (OS-INSP-1.4.4) и заголовок документа.

Блок начинается заголовком «Перечень видов работ, для которых необходимо составление актов
освидетельствования скрытых работ» (или короче — «Перечень скрытых работ»); заголовок может
переноситься на следующую строку. Позиции — нумерованные строки после заголовка: «1. Армирование
фундаментной плиты». Перед первой позицией допускается шапка таблицы («№ п/п Наименование»);
первая ненумерованная строка после позиций закрывает блок. Не нашли — пустой список, не выдумываем.
"""

from __future__ import annotations

import re

from .model import HiddenWork, Line, ParsedDoc
from .normalize import fold
from .parse import union

ITEM_RE = re.compile(r"^\s*(\d{1,3})\s*[.)]?\s+(.*\S)\s*$")
MAX_HEADER_LINES = 3  # строк шапки таблицы между заголовком и первой позицией


def _is_heading(line: str, nxt: str) -> tuple[bool, bool]:
    """(это заголовок перечня, заголовок занимает и следующую строку)."""
    a = fold(line)
    if "перечень" not in a:
        return False, False
    if "скрытых работ" in a:
        return True, False
    if "перечень видов работ" in a and "скрытых работ" in fold(f"{line} {nxt}"):
        return True, True
    return False, False


def _item(line: Line) -> tuple[int, str] | None:
    m = ITEM_RE.match(line.text)
    if not m or len(re.findall(r"[А-Яа-яЁёA-Za-z]", m.group(2))) < 3:
        return None
    return int(m.group(1)), m.group(2).strip(" .;")


def hidden_works(doc: ParsedDoc) -> list[HiddenWork]:
    out: list[HiddenWork] = []
    for page in doc.pages:
        lines = page.lines
        i = 0
        while i < len(lines):
            nxt = lines[i + 1].text if i + 1 < len(lines) else ""
            head, wraps = _is_heading(lines[i].text, nxt)
            if not head:
                i += 1
                continue
            i += 2 if wraps else 1
            started, skipped = False, 0
            while i < len(lines):
                it = _item(lines[i])
                if it:
                    started = True
                    n, text = it
                    bbox = union([w.bbox for w in lines[i].words if w.bbox])
                    out.append(HiddenWork(n=n, text=text, page=page.page, bbox=bbox))
                elif (
                    started
                    or skipped >= MAX_HEADER_LINES
                    or _is_heading(lines[i].text, "")[0]
                ):
                    break
                else:
                    skipped += 1
                i += 1
    return out


def doc_title(doc: ParsedDoc) -> str | None:
    """Заголовок: первая содержательная строка первой непустой страницы (не больше 200 символов)."""
    for page in doc.pages:
        for line in page.lines:
            if len(re.findall(r"[А-Яа-яЁёA-Za-z]", line.text)) >= 3:
                return line.text.strip()[:200]
    return None
