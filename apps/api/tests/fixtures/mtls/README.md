---
owner: almazrobots
---
# Тестовая PKI для mTLS к «РиН» (NFR-MTLS)

Создаётся при запуске тестов (`tests/setup-mtls.ts`, globalSetup vitest), в git не хранится (`.gitignore`):
закрытый ключ в репозитории запрещён, даже синтетический. Нужен openssl. EC P-256 — не ГОСТ: OpenSSL в Node
ГОСТ не умеет, эксплуатационный путь — режим gost-proxy через СКЗИ. Ключи CA удаляются сразу после выпуска.

| Файл | Что это |
|---|---|
| `ca.crt` | корень «РиН» (тестовый), доверяют и клиент, и сервер |
| `server.crt/.key` | сервер «РиН», SAN: IP 127.0.0.1, DNS localhost |
| `client.crt/.key` | клиент «Инспектор ИИ», CN=inspector-test-client |
| `client.p12` | тот же клиент в PKCS#12, пароль `test-only` |
| `other-ca.crt` | «чужой» корень |
| `other-client.crt/.key` | клиент от чужого CA — сервер должен отказать |
| `rogue-server.crt/.key` | сервер от чужого CA — клиент должен отказать |
