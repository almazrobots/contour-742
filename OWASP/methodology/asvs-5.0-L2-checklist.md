---
id: OWASP-ASVS-L2
title: "Чек-лист ASVS 5.0 уровень L2 — состояние платформы"
type: methodology
owner: almazrobots
status: current
created: 2026-09-27
task: T-140
baseline: "полный аудит T-140, main 66593fa"
review: каждый R3 обновляет колонку «Сейчас»; R4 проходит главы по требованиям целиком
---

# ASVS 5.0 L2 — чек-лист платформы

Уровень L2 — целевой для системы, которая обрабатывает ПДн и выносит юридически значимые решения. Оценка идёт по главам;
глава получает `pass`, только если в ней нет открытых находок MEDIUM и выше. Номера — из
[`findings/REGISTER.md`](../findings/REGISTER.md). В колонке «Было» — оценка полного аудита 26.09 (T-088), где она была.

| Глава | Тема | Эксперт | Было | Сейчас (27.09) | Что держит оценку | Что сделано хорошо |
|---|---|---|---|---|---|---|
| V1 | Encoding & Sanitization | E1, E3 | fail (H6) | **partial** | T088-H6 (ReportLab, фикс в T-139) | SQL только `$N`, экспорт XML экранирует, React без `dangerouslySetInnerHTML` |
| V2 | Validation & Business Logic | E1, E3 | partial | **fail** | E3-H1 (невидимый текст задаёт значение), E1-M1, E1-M2, M14, L2 | Zod + OpenAPI на 66/66 маршрутах, вердикт верификации считает сервер |
| V3 | Web Frontend Security | E1 | partial | **partial** | E1-L5 (`/docs` с `unsafe-inline`), T088-L15 | CSP `script-src 'self'`, `frame-ancestors 'none'`, HSTS, нет открытых редиректов |
| V4 | API & Web Service | E1 | partial | **partial** | E1-L1 (схема до аутентификации), T088-L10 | контракт OpenAPI — храповик гейта, 415/413, CORS выключен |
| V5 | File Handling | E1, E3 | partial | **partial** | E3-M2 (TIFF/OOXML), T088-L4, L5, E1-L7 | тип по сигнатуре, имя = SHA-256, zip-бомба и zip slip, XXE, антивирус fail-closed |
| V6 | Authentication | E1 | fail | **fail** | E1-H1 (блокировка всех), M13, E2-H2 (общие учётки на публичном демо), L9 | scrypt, `timingSafeEqual`, `DUMMY_HASH`, bootstrap-admin из секрета |
| V7 | Session Management | E1 | partial | **partial** | L9 (нет тайм-аута бездействия, нет отзыва всех сессий) | 192-битный токен, только заголовок, sha256 в БД, logout инвалидирует |
| V8 | Authorization | E1 | fail | **fail** → partial после T-139 | M1 BOLA, M2 admin (оба в T-139), E1-M2, E1-L2 | роль на каждом маршруте, режим только чтения |
| V9 | Self-contained Tokens | E1 | — | н/п | токены непрозрачные | — |
| V10 | OAuth & OIDC | E1 | — | н/п до Keycloak | — | — |
| V11 | Cryptography | E2 | partial | **partial** | E2-H1 (ключ без ротации и `key_id`), DB-L-9 | AES-256-GCM со случайным nonce, TLS 1.3, SHA-256 |
| V12 | Secure Communication | E2 | partial | **partial** | E2-M2 (TLS 1.2 снаружи), E2-L2 | TLS 1.3 и verify-full внутри, mTLS к «РиН» |
| V13 | Configuration | E2 | partial | **partial** | T088-M3, M6, M11, L13 (регрессия) | секреты PG/брокера/S3 файлами, отказ старта на опасные сочетания gpu |
| V14 | Data Protection | E2, E3 | partial | **fail** | E2-H2 (ПДн на публичном демо), E3-M4 (ПДн в кэшах), DB-M-6, DB-M-10 | журналы append-only, хеш логина в `LOGIN_FAILED` |
| V15 | Secure Coding & Architecture | E3, E2 | — | **partial** | E3-M1 (сверхлинейная работа под замком), E3-M3, T088-M7 | нет `pickle`/`eval`, tesseract списком аргументов, предметная логика — чистые функции |
| V16 | Security Logging & Error Handling | E1, E2 | fail | **fail** | E2-M4 (нет алертов безопасности), E1-H1 (IP прокси в журнале), E1-L3, E1-L4 | решение и аудит в одной транзакции, ответы без стеков |
| V17 | WebRTC | — | — | н/п | — | — |

**Итог:** из 14 применимых глав `pass` — 0, `partial` — 9, `fail` — 5 (V2, V6, V8, V14, V16).
Самые короткие пути до `partial` по провальным главам:
- V6 и V16: T-090 (`trustProxy`, `limit_req`, M13);
- V8: влитие T-139;
- V14: решение по T-143;
- V2: T-149.

## Как проходить главу целиком (R4)

1. Открыть главу ASVS 5.0 на github.com/OWASP/ASVS (ветка v5.0.0) и выписать требования L1+L2.
2. По каждому требованию указать: `pass` со ссылкой на код или тест, `fail` с номером находки, `н/п` с причиной.
3. Результат положить в `audits/<папка R4>/asvs-V<N>.md`, а итог главы перенести сюда.
