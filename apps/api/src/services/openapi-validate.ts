// NFR-API-VALIDATE (ТЗ 1.3 «все запросы и ответы — JSON с обязательной валидацией схемы OpenAPI 3.0», T-129).
// Единственный источник схемы — openapi.ts. Маршрут Fastify сопоставляется с путём OpenAPI по шаблону
// (/inspection/:id ≡ /inspection/{process_id}); запрос проверяется до обработчика (400 с перечнем нарушений),
// JSON-ответ — перед отправкой: ответ, не совпавший со схемой своего кода, не уходит клиенту (500 и запись в лог).
import { Ajv, type ValidateFunction } from "ajv";
import addFormatsModule from "ajv-formats";

// ajv-formats — CommonJS: функция под default
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule) as unknown as (a: Ajv) => Ajv;
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

type Op = { parameters?: Array<{ name: string; in: string; required?: boolean; schema: unknown }>; requestBody?: { content?: Record<string, { schema: unknown }> }; responses?: Record<string, { content?: Record<string, { schema: unknown }> }> };

/** Шаблон пути без имён параметров: /a/:id/b и /a/{process_id}/b → /a/{}/b. */
export const pathKey = (p: string): string => p.replace(/\{[^}]+\}|:[A-Za-z_][\w]*/g, "{}").replace(/\/+$/, "") || "/";

/**
 * OpenAPI 3.0 → JSON Schema: «nullable: true» без type (ссылка, пустая схема) ajv не принимает — такой узел
 * переписывается в anyOf [схема, null]. Узлы с type ajv понимает сам.
 */
export function toJsonSchema(node: unknown): any {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = toJsonSchema(v);
  if (out.nullable === true && out.type === undefined) {
    delete out.nullable;
    return { anyOf: [out, { type: "null" }] };
  }
  return out;
}

export interface Compiled {
  path?: { names: string[]; check: ValidateFunction };
  query?: ValidateFunction;
  body?: ValidateFunction;
  responses: Map<string, ValidateFunction>;
}

/** Собрать валидаторы из документа OpenAPI 3.0. Ключ — «METHOD шаблон». */
export function compileOpenapi(doc: { paths: Record<string, Record<string, Op>>; components?: { schemas?: Record<string, unknown> } }): Map<string, Compiled> {
  // nullable — ключевое слово OpenAPI 3.0; ajv понимает его сам, strict выключен ради example/description/format без плагина
  const ajv = new Ajv({ strict: false, allErrors: true, coerceTypes: false });
  // строка запроса и путь приходят строками: для них типы приводятся («?page=2» → 2), как это делает сам Fastify
  const ajvQuery = new Ajv({ strict: false, allErrors: true, coerceTypes: true });
  // format: date-time и прочие — проверяются, а не игнорируются с предупреждением
  addFormats(ajv);
  addFormats(ajvQuery);
  ajvQuery.addSchema({ $id: "openapi", components: toJsonSchema(doc.components ?? {}) });
  ajv.addSchema({ $id: "openapi", components: toJsonSchema(doc.components ?? {}) });
  const fix = (s: unknown): unknown => toJsonSchema(JSON.parse(JSON.stringify(s).replace(/"#\/components\//g, '"openapi#/components/')));
  const out = new Map<string, Compiled>();
  for (const [p, methods] of Object.entries(doc.paths)) {
    for (const [m, op] of Object.entries(methods)) {
      const c: Compiled = { responses: new Map() };
      const group = (where: string) => {
        const ps = (op.parameters ?? []).filter((x) => x.in === where);
        if (!ps.length) return undefined;
        return ajvQuery.compile({ type: "object", properties: Object.fromEntries(ps.map((x) => [x.name, fix(x.schema)])), required: ps.filter((x) => x.required).map((x) => x.name) });
      };
      c.query = group("query");
      // параметры пути: в OpenAPI «{id}», в Fastify «:id» — сопоставляются по позиции в шаблоне (SEC-05)
      const pathSchema = group("path");
      if (pathSchema) c.path = { names: [...p.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]), check: pathSchema };
      const body = op.requestBody?.content?.["application/json"]?.schema;
      if (body) c.body = ajv.compile(fix(body) as object);
      for (const [code, r] of Object.entries(op.responses ?? {})) {
        const s = r.content?.["application/json"]?.schema;
        if (s) c.responses.set(code, ajv.compile(fix(s) as object));
      }
      out.set(`${m.toUpperCase()} ${pathKey(p)}`, c);
    }
  }
  return out;
}

const fmt = (v: ValidateFunction) =>
  (v.errors ?? []).map((e) => ({ path: e.instancePath || "/", message: e.message ?? "", keyword: e.keyword, ...(e.keyword === "enum" ? { allowed: (e.params as { allowedValues: unknown[] }).allowedValues } : {}) }));

export class SchemaViolation extends Error {
  constructor(public where: "request" | "response", public details: Array<{ path: string; message: string; keyword: string; allowed?: unknown[] }>) {
    // в тексте — первое нарушение словами: клиенту не нужно разбирать details, чтобы понять причину
    const d = details[0];
    super(`${where === "request" ? "Запрос не соответствует схеме OpenAPI" : "Ответ не соответствует схеме OpenAPI"}${d ? `: ${d.path} ${d.message}${d.allowed ? ` (${d.allowed.join(", ")})` : ""}` : ""}`);
  }
}

/**
 * Подключить проверку к приложению. only — ключи «METHOD /путь», для которых проверка обязательна (храповик: список
 * растёт, пока не покроет все маршруты; гейт tests/openapi-contract.test.ts не даёт маршруту остаться без схемы).
 */
export function attachOpenapiValidation(app: FastifyInstance, doc: Parameters<typeof compileOpenapi>[0], log: (level: "ERROR", msg: string, extra?: Record<string, unknown>) => void): Array<{ method: string; url: string }> {
  const v = compileOpenapi(doc);
  // реестр маршрутов приложения — для гейта «каждый маршрут описан в OpenAPI» (tests/openapi-contract.test.ts)
  const routes: Array<{ method: string; url: string }> = [];
  app.addHook("onRoute", (r) => {
    for (const m of [r.method].flat()) if (m !== "HEAD" && m !== "OPTIONS") routes.push({ method: m, url: r.url });
  });
  const find = (req: FastifyRequest) => v.get(`${req.method} ${pathKey(req.routeOptions.url ?? "")}`);
  app.addHook("preValidation", async (req: FastifyRequest) => {
    const c = find(req);
    if (!c) return;
    if (c.query && !c.query(req.query ?? {})) throw new SchemaViolation("request", fmt(c.query));
    if (c.path) {
      const vals = [...(req.routeOptions.url ?? "").matchAll(/:([A-Za-z0-9_]+)/g)].map((x) => (req.params as Record<string, string>)[x[1]]);
      const obj = Object.fromEntries(c.path.names.map((n, i) => [n, vals[i]])); // копия: приведение типов не трогает req.params
      if (!c.path.check(obj)) throw new SchemaViolation("request", fmt(c.path.check));
    }
    // тело проверяется при любом JSON-типе без учёта регистра («Application/JSON» Fastify тоже разбирает — SEC-05);
    // multipart (загрузка файлов) проверяет свой обработчик
    const ct = String(req.headers["content-type"] ?? "").toLowerCase();
    if (c.body && req.body !== undefined && !ct.startsWith("multipart/") && !c.body(req.body)) throw new SchemaViolation("request", fmt(c.body));
  });
  app.addHook("preSerialization", async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const c = find(req);
    if (!c) return payload;
    const check = c.responses.get(String(reply.statusCode)) ?? c.responses.get(`${String(reply.statusCode)[0]}XX`) ?? c.responses.get("default");
    if (check && !check(payload)) {
      const details = fmt(check);
      log("ERROR", "ответ не соответствует схеме OpenAPI", { route: `${req.method} ${req.routeOptions.url}`, status: reply.statusCode, details });
      if (process.env.INSPECTOR_OPENAPI_DEBUG) console.error("OPENAPI", req.method, req.routeOptions.url, reply.statusCode, JSON.stringify(details).slice(0, 700));
      reply.code(500);
      // наружу — без внутренностей ответа (SEC-06, ASVS V16): подробности только в журнале, связь — по request_id
      return { error: `Внутренняя ошибка сервера (запрос ${req.id})` };
    }
    return payload;
  });
  return routes;
}
