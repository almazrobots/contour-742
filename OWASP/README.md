---
id: OWASP-README
title: "OWASP-программа «Инспектора ИИ»"
type: index
owner: almazrobots
status: current
created: 2026-09-27
task: T-140
---

# OWASP — безопасность платформы

Здесь лежит всё про OWASP-аудиты «Инспектора ИИ»: план, методики, реестр находок, отчёты, инструменты.
Раньше отчёты лежали в `docs/audit/`; на их прежних местах остались тумбстоуны.

| Нужно | Куда смотреть |
|---|---|
| Как устроен регулярный аудит, ритмы, SLA, календарь | [`MEGAPLAN.md`](MEGAPLAN.md) |
| Что сейчас открыто и в каком статусе | [`findings/REGISTER.md`](findings/REGISTER.md) |
| Все проведённые аудиты | [`audits/INDEX.md`](audits/INDEX.md) |
| Последний полный аудит | [`audits/2026-09-27-full-T140/report.md`](audits/2026-09-27-full-T140/report.md) |
| Какой стандарт OWASP к чему применяем | [`methodology/standards-map.md`](methodology/standards-map.md) |
| Чек-лист ASVS 5.0 L2 | [`methodology/asvs-5.0-L2-checklist.md`](methodology/asvs-5.0-L2-checklist.md) |
| Модель угроз | [`methodology/threat-model.md`](methodology/threat-model.md) |
| Зрелость процесса (SAMM) | [`methodology/samm-assessment.md`](methodology/samm-assessment.md) |
| Активы и точки входа | [`scope/asset-inventory.md`](scope/asset-inventory.md) |
| Шаблоны: бриф эксперта, находка, отчёт | [`templates/`](templates/) |
| Запустить автоматические сканы | `scripts/heavy.sh OWASP/tooling/owasp-scan.sh [каталог] [--quick]` |

## Правила

1. Статус находки меняется **только в реестре**. Отчёт аудита после сдачи не правится: он фиксирует срез на свой коммит.
2. Находка закрывается вместе с тестом, который краснеет при возврате дефекта. Без теста находка остаётся в статусе `fixed`, до `verified` она не доходит.
3. Новая поверхность атаки проходит точечный аудит (R2) **до** влития в `main`. Триггеры перечислены в `MEGAPLAN.md` §5.
4. Корпус, секреты, токены и ПДн сюда не попадают. Доказательства собираются только на синтетике.
5. Ничего не удаляется: устаревшее уходит в `_archive/`, на прежнем месте остаётся тумбстоун.
