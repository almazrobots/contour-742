"""M-022: субъект и неоднозначность степени; не выводит степень из REI или OCR-подмен.

Границы контекста задаёт извлекатель по исходным строкам. Поддерживаются явно
подписанные корпуса, секции и пожарные отсеки; геометрическое наследование таблиц
не имитируется текстовым поиском.
"""
from __future__ import annotations

import re

# Номер или одна прописная литера. Строчная «в» в «корпус в осях» не идентификатор.
_SUBJECT = re.compile(
    r"(?P<kind>(?i:корпус[а-яё]*|секци[а-яё]*|пожарн[а-яё]*\s+отсек[а-яё]*))"
    r"\s*(?:№\s*)?[«\"]?(?P<id>\d{1,4}(?:[.\-]\d{1,3})?[А-Яа-яA-Za-z]?|[А-ЯA-Z])[»\"]?(?![\w])"
)
_LABEL = re.compile(r"\b(?:корпус[а-яё]*|секци[а-яё]*|пожарн[а-яё]*\s+отсек[а-яё]*)\b", re.I)
_KIND = {"корпус": "building", "секци": "section", "пожарн": "fire_compartment"}
_ROMAN = r"(?:IV|III|II|I|V|І{1,3})"
_ALTERNATIVE = re.compile(rf"\s*(?:[–—/\-]|или|либо|,)\s*{_ROMAN}(?!\w)", re.I)
_ALTERNATIVE_BEFORE = re.compile(rf"(?<!\w){_ROMAN}\s*(?:[–—/\-]|или|либо|,)\s*$", re.I)
_NEGATED = re.compile(r"(?:\bне\s*|\bне\s+(?:выше|более)\s*)$", re.I)


def assess(text: str, lo: int, hi: int, v_start: int, v_end: int):
    """(правило отсева, ключ субъекта, диапазон подписи). Ключ не угадывается."""
    scope = text[lo:hi]
    rule = None
    # A statement about required construction performance is not a declaration
    # of the inspected building's degree, even when it contains one Roman value.
    if re.search(r"(?:минимальн\w*\s+предел|допускается\s+применять|соответствующ\w*\s+предел\w*).*", scope, re.I):
        rule = {"code": "NORM_STATEMENT", "why": "требование к конструкциям или условие применения — не заявленная степень объекта"}
    if _ALTERNATIVE.match(text[v_end:hi]) or _ALTERNATIVE_BEFORE.search(text[lo:v_start]) or _NEGATED.search(text[max(lo, v_start - 30):v_start]):
        rule = {"code": "AMBIGUOUS_DEGREE", "why": "альтернатива, диапазон или отрицание степени — не установленный факт"}
    subjects = list(_SUBJECT.finditer(scope))
    ids: dict[str, str] = {}
    for match in subjects:
        kind = next(v for k, v in _KIND.items() if match['kind'].lower().startswith(k))
        value = match['id'].upper()
        if kind in ids and ids[kind] != value:
            rule = {"code": "AMBIGUOUS_SUBJECT", "why": "несколько субъектов одного вида без однозначной привязки степени"}
        ids[kind] = value
    # Generic prose about division into compartments after an explicit degree
    # does not introduce an unresolved identifier for that degree.
    unresolved = _SUBJECT.sub("", scope)
    unresolved = re.sub(r"(?:на|в\s+пределах)\s+(?:одного|один|два|двух|три|тр[её]х|\d+)\s+пожарн\w*\s+отсек\w*", "", unresolved, flags=re.I)
    if _LABEL.search(unresolved) or any(re.match(r"\s*(?:,|и|или|–|-)\s*(?:№\s*)?[«\"]?(?:\d|[А-ЯA-Z](?!\w))", scope[m.end():], re.I) for m in subjects):
        rule = {"code": "AMBIGUOUS_SUBJECT", "why": "подпись субъекта или перечисление не разобраны однозначно"}
    key = "/".join(f"{k}:{ids[k]}" for k in _KIND.values() if k in ids) or None
    span = (lo + subjects[0].start(), lo + subjects[-1].end()) if subjects else None
    return rule, key, span


def heading_start(text: str, lo: int, joins: frozenset[int]) -> int:
    """Наследовать только непосредственно предшествующую строку чистых подписей.

    Не протягивает субъект через произвольный текст или с предыдущей страницы.
    """
    # Подпись и значение могут быть на одной исходной строке, разделённые
    # точкой. Наследуем только чистую цепочку подписей, не соседний рассказ.
    line_start = max((j + 1 for j in joins if j < lo), default=0)
    prefix = text[line_start:lo]
    if _SUBJECT.search(prefix) and not re.sub(r"[\s.:;—–-]", "", _SUBJECT.sub("", prefix)):
        lo = line_start
    for _ in range(8):
        previous = max((j for j in joins if j < lo), default=-1)
        if previous < 0 or text[previous + 1:lo].strip():
            break
        start = max((j + 1 for j in joins if j < previous), default=0)
        candidate = text[start:previous]
        if not _LABEL.match(candidate.strip()) or len(candidate) > 120 or re.search(r"огнестойкост|степен|преде[лн]|согласно", candidate, re.I):
            break
        lo = start
    return lo
