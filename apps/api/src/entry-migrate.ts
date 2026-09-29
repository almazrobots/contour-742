// Метка точки входа «служба миграций» (HIGH-1). Импортируется первой строкой migrate.ts — раньше config.ts, поэтому
// конфигурация знает, что API-проверки (очередь, TLS API, «РиН») здесь не нужны. Из окружения метку не поставить.
(globalThis as Record<symbol, unknown>)[Symbol.for("inspector.entry")] = "migrate";
