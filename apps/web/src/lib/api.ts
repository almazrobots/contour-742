// Клиент API. Токен сессии хранится в sessionStorage (закрыл вкладку — вышел).
import {apiUrl,verificationOnly} from './verification-mode';
export type User = { id: string; login: string; name: string; role: "inspector" | "supervisor" | "admin" | "ml_engineer" | "curator" | "verifier" };

const KEY = verificationOnly?"verification.session":"inspector.session";

export function session(): { token: string; user: User } | null {
  try {
    const s = sessionStorage.getItem(KEY);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

export function setSession(s: { token: string; user: User } | null) {
  try {
    if (s) sessionStorage.setItem(KEY, JSON.stringify(s));
    else sessionStorage.removeItem(KEY);
  } catch {
    /* приватный режим — живём без сохранения */
  }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const s = session();
  if (s) headers.authorization = `Bearer ${s.token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const r = await fetch(apiUrl(path), { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
  if (r.status === 401 && !path.endsWith("/login")) {
    setSession(null);
    location.hash = "#/login";
  }
  const type = r.headers.get("content-type") ?? "";
  const data = type.includes("json") ? await r.json() : await r.text();
  if (!r.ok) throw new ApiError(r.status, (data as any)?.error ?? `Ошибка ${r.status}`);
  return data as T;
}

export async function download(path: string, filename: string) {
  const s = session();
  const r = await fetch(apiUrl(path), { headers: s ? { authorization: `Bearer ${s.token}` } : {} });
  if (!r.ok) throw new ApiError(r.status, "Не удалось выгрузить файл");
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function fileBytes(fileId: string): Promise<ArrayBuffer> {
  const s = session();
  const r = await fetch(`/api/v1/files/${fileId}/content`, { headers: s ? { authorization: `Bearer ${s.token}` } : {} });
  if (!r.ok) throw new ApiError(r.status, "Файл недоступен");
  return r.arrayBuffer();
}
