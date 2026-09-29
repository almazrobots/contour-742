---
id: OWASP-STANDARDS-MAP
title: "Карта стандартов OWASP по зонам платформы"
type: methodology
owner: almazrobots
status: current
created: 2026-09-27
task: T-140
---

# Карта стандартов OWASP

Версии указаны на 27.09.2026. Перед каждым R4 версии сверяются с github.com/OWASP: стандарты обновляются,
а номера категорий между редакциями меняются.

## Что применяем и зачем

| Стандарт | Версия | Роль в программе | Зоны | Эксперт |
|---|---|---|---|---|
| OWASP Top 10 | 2025 | язык классификации всех находок (A01–A10) | все | все |
| API Security Top 10 | 2023 | классификация находок API (API1–API10) | Z1, Z3 | E1 |
| Application Security Verification Standard (ASVS) | 5.0, уровень L2 | **основной чек-лист требований** | Z1–Z8 | все, по главам |
| Web Security Testing Guide (WSTG) | 4.2 / latest | методика живого прогона | Z1, Z2 | E1 |
| Cheat Sheet Series | latest | эталон фикса в каждой находке | все | все |
| Proactive Controls | 2024 | проверка, что защита заложена в код, а не навешена | Z1, Z7 | E1, E3 |
| Top 10 for LLM Applications | 2025 | классификация рисков LLM/VLM | Z7, Z8 | E3 |
| Machine Learning Security Top 10 | 2023 | риски моделей, данных, дообучения | Z7, Z8 | E3 |
| AI Exchange, Agentic AI Threats & Mitigations | latest | советник и будущая агентность | Z8 | E3 |
| Top 10 CI/CD Security Risks | 2022 | конвейер, раннер, публикация | Z6 | E2 |
| Software Component Verification Standard (SCVS) | 1.0 | состав и происхождение компонентов | Z6 | E2 |
| CycloneDX | 1.6 | формат SBOM | Z6 | E2 |
| Docker Security Cheat Sheet | latest | контейнеры и compose | Z5 | E2 |
| Top 10 Privacy Risks | 2021 | ПДн вместе с 152-ФЗ | Z4, Z8 | E3 |
| Threat Modeling (STRIDE), Threat Dragon | — | модель угроз по границам доверия | все | ведущий |
| Software Assurance Maturity Model (SAMM) | 2.0 | зрелость процесса, план роста | программа | ведущий |
| CVSS | 4.0 | числовая тяжесть HIGH и выше | все | все |
| OWASP Risk Rating Methodology | — | обоснование принятого риска | все | владелец |

## ASVS 5.0: какая глава за каким экспертом

| Глава ASVS 5.0 | Тема | Эксперт |
|---|---|---|
| V1 | Encoding and Sanitization | E1, E3 (рендер протокола) |
| V2 | Validation and Business Logic | E1, E3 |
| V3 | Web Frontend Security | E1 |
| V4 | API and Web Service | E1 |
| V5 | File Handling | E1 (приём), E3 (разбор) |
| V6 | Authentication | E1 |
| V7 | Session Management | E1 |
| V8 | Authorization | E1 |
| V9 | Self-contained Tokens | E1 (н/п: токены непрозрачные) |
| V10 | OAuth and OIDC | E1 (н/п до Keycloak) |
| V11 | Cryptography | E2 |
| V12 | Secure Communication | E2 |
| V13 | Configuration | E2 |
| V14 | Data Protection | E2, E3 |
| V15 | Secure Coding and Architecture | E3, E2 |
| V16 | Security Logging and Error Handling | E1, E2 |
| V17 | WebRTC | н/п |

## Инструменты

| Инструмент | Что ловит | Где запускается | Ритм |
|---|---|---|---|
| gitleaks | секреты в истории | гейт, `owasp-scan.sh` | R0 |
| trivy fs / image / config | CVE, секреты, ошибки конфигурации | гейт (образы), `owasp-scan.sh` (fs, config) | R0, R1 |
| hadolint | Dockerfile | локальный гейт, `owasp-scan.sh` | R0 |
| pnpm audit | CVE npm | `owasp-scan.sh` → гейт | R1 → R0 |
| pip-audit (через `uvx`, по `uv export`) | CVE PyPI | `owasp-scan.sh` → гейт | R1 → R0 |
| semgrep (p/owasp-top-ten, p/typescript, p/python) | SAST | `owasp-scan.sh` | R1 |
| bandit | SAST Python | `owasp-scan.sh` | R1 |
| syft | SBOM CycloneDX | `owasp-scan.sh` | R1, R3 |
| vitest / pytest: тесты безопасности | регрессии закрытых находок | гейт | R0 |
| живой прогон локального API | WSTG-сценарии | эксперт E1 | R3 |
| OWASP ZAP | DAST | отдельный стенд, с разрешения владельца | R4 |
