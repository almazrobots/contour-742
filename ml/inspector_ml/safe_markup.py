"""Текст из данных в PDF и DOCX протокола — только как текст (T-094, OWASP H6).

OS-INSP-5.1.20: ReportLab `Paragraph` читает строку как мини-разметку — `<font>`, `<img src=…>`, `<a>`
исполнились бы, а голые `<` и `&` роняют выгрузку. Поэтому значение из документа, ответа ИИ или комментария
экранируется (`pdf_text`); свою служебную разметку вокруг него пишем сами.
OS-INSP-5.1.21: XML 1.0 не допускает управляющих символов (кроме табуляции и переводов строки), суррогатов и
U+FFFE/U+FFFF — python-docx на них падает. `docx_text` их убирает.
"""

from __future__ import annotations

import re
from xml.sax.saxutils import escape

# недопустимое в XML 1.0: C0 без \t \n \r, одиночные суррогаты, U+FFFE и U+FFFF
_XML_INVALID = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]")


def _str(s: object) -> str:
    return "" if s is None else str(s)


def pdf_text(s: object) -> str:
    """Значение для ReportLab `Paragraph`: `<`, `>`, `&` — сущностями, None — пустая строка (OS-INSP-5.1.20)."""
    return escape(_str(s))


def docx_text(s: object) -> str:
    """Значение для python-docx: без символов, недопустимых в XML 1.0; None — пустая строка (OS-INSP-5.1.21)."""
    return _XML_INVALID.sub("", _str(s))
