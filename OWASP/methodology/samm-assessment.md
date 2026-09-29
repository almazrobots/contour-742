---
id: OWASP-SAMM
title: "Оценка зрелости по OWASP SAMM 2.0"
type: methodology
owner: almazrobots
status: current
created: 2026-09-27
task: T-140
review: R4, ежеквартально
---

# Зрелость процесса безопасности — OWASP SAMM 2.0

Первая оценка, 27.09.2026. Шкала SAMM: 0 — нет практики, 1 — разовая, 2 — систематическая, 3 — измеряемая и
оптимизируемая. Каждая оценка подкреплена артефактом в репозитории; без артефакта практика считается ниже.

| Функция | Практика | Сейчас | Доказательство | Цель Q1 2027 | Шаг вперёд |
|---|---|---|---|---|---|
| Governance | Strategy & Metrics | 1 | `OWASP/MEGAPLAN.md` §1 — метрики заданы, но ещё не считались | 2 | метрики реестра в каждом R3 |
| Governance | Policy & Compliance | 1 | ADR-0002 (корпус), 152-ФЗ — T-074 в работе | 2 | ASVS L2 как политика, 152-ФЗ закрыт |
| Governance | Education & Guidance | 1 | правила в `CLAUDE.md`, Cheat Sheets в находках | 1 | — |
| Design | Threat Assessment | 1 | `methodology/threat-model.md` (впервые 27.09) | 2 | пересмотр при каждом R2 |
| Design | Security Requirements | 2 | ГЕРА: NFR-TLS, NFR-DB, NFR-OBJSTORE с трассировкой к тестам | 2 | требования из находок — через ГЕРУ |
| Design | Security Architecture | 2 | ADR-0001/0003/0006, сети `internal`, роли PG | 2 | — |
| Implementation | Secure Build | 2 | образы по digest, lock с хешами, `read_only`, без npm в рантайме | 3 | SBOM + cosign (T088-M10) |
| Implementation | Secure Deployment | 1 | деплой из git, но раннер с docker.sock (T088-H5) | 2 | изолированный раннер T-093 |
| Implementation | Defect Management | 1 | задачи T-089…T-095, но реестра не было | 2 | `findings/REGISTER.md` + SLA §8 |
| Verification | Architecture Assessment | 1 | аудиты T-088, T-104 | 2 | R3 ежемесячно |
| Verification | Requirements-driven Testing | 2 | тесты на каждую находку T-129 и T-107, мутационное тестирование | 3 | колонка «Тест» реестра ≥ 90 % |
| Verification | Security Testing | 1 | trivy и gitleaks в гейте; SAST и аудита зависимостей нет | 2 | `owasp-scan.sh` в R1, pnpm/pip audit в гейт |
| Operations | Incident Management | 0 | журнала инцидентов нет | 1 | `OWASP/incidents/` + разбор |
| Operations | Environment Management | 2 | hardening compose, `apk upgrade`, недельная пересборка | 2 | — |
| Operations | Operational Management | 1 | бэкапы — T-072 не закрыт | 2 | восстановление проверено учением |

**Итог:** средняя 1,3. Сильные стороны — Design и Secure Build. Слабые — Operations и Security Testing.
