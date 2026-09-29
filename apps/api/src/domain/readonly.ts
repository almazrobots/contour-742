// Демо-стенд только для просмотра (T-131, NFR-DEMO-READONLY). Правило в API, а не только в интерфейсе: прямой запрос
// к API изменить ничего не может. Чтение (GET, HEAD, OPTIONS) открыто; из изменяющих — только вход и выход.
export const READONLY_MESSAGE = "Демо-стенд только для просмотра: изменения отключены";
const OPEN = new Set(["/api/v1/auth/login", "/api/v1/auth/guest", "/api/v1/auth/logout"]);

/** Запрос запрещён в режиме только чтения? Путь сравнивается без строки запроса и без хвостового «/». */
export function readonlyBlocked(readonly: boolean, method: string, url: string): boolean {
  if (!readonly) return false;
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return false;
  const path = url.split("?")[0].replace(/\/+$/, "");
  return !OPEN.has(path);
}

/** Гостевой вход: только на демо-стенде (только чтение) и только с явно заданной учёткой — без неявного «inspector». */
export const guestEnabled = (readonly: boolean, guestLogin: string): boolean => readonly && guestLogin.trim() !== "";
