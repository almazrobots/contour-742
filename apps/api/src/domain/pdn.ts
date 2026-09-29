// NFR-PDN (ТЗ 12.6-01): персональные данные по 152-ФЗ — реестр, маскирование в логах, минимизация выдачи,
// срок хранения и обезличивание (ст. 21 ч. 7), локализация хранилища (ст. 18 ч. 5). Только чистые функции;
// запись в базу и расписание — services/pdn.ts. Человекочитаемый реестр — docs/security/PDN-REGISTRY.md.

const DAY = 86400_000;

export type PdnCategory =
  | "ФИО"
  | "логин"
  | "наименование/ФИО заказчика"
  | "наименование/ФИО подрядчика"
  | "IP-адрес"
  | "User-Agent"
  | "ФИО в снимке протокола"
  | "логин в журнале неудачных входов";

export type PdnProtection =
  | "маскирование в логах"
  | "обезличивание по сроку"
  | "ролевой доступ"
  | "маскирование в выдаче"
  | "не передаётся в «РиН»"
  | "хеш вместо значения для неизвестного логина"
  | "шифрование канала (TLS)";

export interface PdnEntry {
  table: string;
  column: string;
  /** Путь внутри JSON-колонки (протокол): ПДн лежит не во всей колонке. */
  path?: string;
  category: PdnCategory;
  subject: string;
  purpose: string;
  basis: string;
  /** Срок хранения в днях или «до цели» — пока нужна для цели обработки (срок — в note). */
  retention_days: number | "до цели";
  retention_note: string;
  protection: PdnProtection[];
}

// Основания — допущение проекта (оператор — орган государственного строительного надзора); сверяет юрист оператора.
const BASIS_EMPLOYEE = "152-ФЗ ст. 6 ч. 1 п. 2 — обязанности оператора как работодателя (ТК РФ гл. 14) и по защите информации (149-ФЗ ст. 16)";
const BASIS_SUPERVISION = "152-ФЗ ст. 6 ч. 1 п. 4 — исполнение полномочий органа государственного строительного надзора (ГрК РФ ст. 54)";
const BASIS_AUDIT = "152-ФЗ ст. 6 ч. 1 п. 2 — обязанность вести журнал событий безопасности (149-ФЗ ст. 16, ТЗ 12.4)";

export const PDN_REGISTRY: readonly PdnEntry[] = [
  {
    table: "users", column: "name", category: "ФИО", subject: "работник оператора (инспектор, супервизор, администратор, ML-инженер, куратор)",
    purpose: "Указать должностное лицо, принявшее решение, в карточке проверки, журнале аудита и протоколе (ТЗ 9.3, 12.4)",
    basis: BASIS_EMPLOYEE, retention_days: "до цели",
    retention_note: "пока учётка активна; через INSPECTOR_PDN_USER_DAYS (30) дней после выключения — «Обезличен #id»",
    protection: ["маскирование в логах", "обезличивание по сроку", "ролевой доступ"],
  },
  {
    table: "users", column: "login", category: "логин", subject: "работник оператора",
    purpose: "Вход в систему и разграничение доступа по ролям (ТЗ 12.1, 12.2)",
    basis: BASIS_EMPLOYEE, retention_days: "до цели",
    retention_note: "пока учётка активна; через INSPECTOR_PDN_USER_DAYS (30) дней после выключения — deleted-<id>",
    protection: ["маскирование в логах", "обезличивание по сроку"],
  },
  {
    table: "objects", column: "customer", category: "наименование/ФИО заказчика", subject: "застройщик (технический заказчик) — физлицо или ИП",
    purpose: "Идентификация объекта надзора и адресата предписаний в карточке проверки",
    basis: BASIS_SUPERVISION, retention_days: "до цели",
    retention_note: "срок хранения дела надзора (архивное законодательство); удаление — вместе с проверкой",
    protection: ["ролевой доступ", "маскирование в выдаче", "маскирование в логах"],
  },
  {
    table: "objects", column: "contractor", category: "наименование/ФИО подрядчика", subject: "лицо, осуществляющее строительство, — физлицо или ИП",
    purpose: "Идентификация лица, осуществляющего строительство, в карточке проверки",
    basis: BASIS_SUPERVISION, retention_days: "до цели",
    retention_note: "срок хранения дела надзора (архивное законодательство); удаление — вместе с проверкой",
    protection: ["ролевой доступ", "маскирование в выдаче", "маскирование в логах"],
  },
  {
    table: "audit_log", column: "ip_address", category: "IP-адрес", subject: "пользователь системы (в том числе неудачный вход)",
    purpose: "Расследование инцидентов безопасности: с какого узла совершено действие (ТЗ 12.4, 13.3)",
    basis: BASIS_AUDIT, retention_days: 365,
    retention_note: "365 дней (INSPECTOR_PDN_AUDIT_DAYS), затем NULL функцией БД pdn_anonymize_audit; запись журнала остаётся",
    protection: ["обезличивание по сроку", "ролевой доступ", "маскирование в выдаче", "маскирование в логах"],
  },
  {
    table: "audit_log", column: "user_agent", category: "User-Agent", subject: "пользователь системы",
    purpose: "Расследование инцидентов безопасности: клиент, которым совершено действие (ТЗ 12.4)",
    basis: BASIS_AUDIT, retention_days: 365,
    retention_note: "365 дней (INSPECTOR_PDN_AUDIT_DAYS), затем NULL функцией БД pdn_anonymize_audit",
    protection: ["обезличивание по сроку", "ролевой доступ", "маскирование в логах"],
  },
  {
    table: "audit_log", column: "details", path: "login", category: "логин в журнале неудачных входов", subject: "пользователь системы",
    purpose: "Выявление подбора пароля к существующей учётке (ТЗ 12.2, 13.3)",
    basis: BASIS_AUDIT, retention_days: "до цели",
    retention_note: "срок журнала аудита; журнал неизменяем — обезличивание details не выполняется (ограничение, см. документ)",
    protection: ["хеш вместо значения для неизвестного логина", "ролевой доступ"],
  },
  {
    table: "protocols", column: "body_json", path: "sections.*.decision.user_name", category: "ФИО в снимке протокола", subject: "инспектор, принявший решение",
    purpose: "Протокол проверки — документ надзора: подтверждает, кто принял решение по нарушению (ТЗ 9.3 п. 4)",
    basis: BASIS_SUPERVISION, retention_days: "до цели",
    retention_note: "финализированный протокол неизменяем и хранится со делом надзора; в «РиН» уходит только user_id",
    protection: ["не передаётся в «РиН»", "ролевой доступ"],
  },
];

/** Колонки, чьё имя совпало со словарём, но ПДн не содержат. Причина обязательна — гейт это проверяет. */
export const PDN_NOT_PERSONAL: readonly { table: string; column: string; reason: string }[] = [
  { table: "objects", column: "name", reason: "наименование объекта капитального строительства (ЖК, корпус), не субъекта" },
  { table: "rooms", column: "name", reason: "наименование помещения из экспликации чертежа" },
  { table: "hidden_seals", column: "name", reason: "имя файла печати скрытого теста (латиница, цифры, точка)" },
];

/** Словарь-детектор: колонка с таким именем (или суффиксом _<имя> для сильных признаков) — кандидат в ПДн. */
export const PDN_COLUMN_NAMES = ["name", "login", "customer", "contractor", "ip_address", "user_agent", "phone", "email", "fio", "full_name", "snils", "passport"] as const;
const STRONG_SUFFIX = ["phone", "email", "fio", "full_name", "snils", "passport", "ip_address", "user_agent"];

export function isPdnColumnName(c: string): boolean {
  const n = c.toLowerCase();
  return (PDN_COLUMN_NAMES as readonly string[]).includes(n) || STRONG_SUFFIX.some((s) => n.endsWith(`_${s}`));
}

// ─────────────────────────────── гейт реестра: колонки ПДн в миграциях

const unquote = (s: string) => s.replace(/"/g, "").split(".").pop()!.toLowerCase();

/** Разделить по запятым верхнего уровня (скобки CHECK/типов не режутся). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const NOT_COLUMN = new Set(["constraint", "unique", "primary", "foreign", "check", "exclude", "like"]);

/** Колонки из словаря ПДн, заводимые SQL миграции: create table, alter table … add column, rename column … to. */
export function pdnColumnsInSql(sql: string): Array<{ table: string; column: string }> {
  const clean = sql
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "") // тела функций
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "");
  const out: Array<{ table: string; column: string }> = [];
  const push = (table: string, column: string) => {
    if (isPdnColumnName(column)) out.push({ table, column });
  };
  for (const stmt of clean.split(";")) {
    const create = /^\s*create\s+(?:(?:temporary|temp|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?([\w."]+)\s*\(/i.exec(stmt);
    if (create) {
      const table = unquote(create[1]);
      let depth = 1;
      let i = create[0].length;
      for (; i < stmt.length && depth > 0; i++) {
        if (stmt[i] === "(") depth++;
        if (stmt[i] === ")") depth--;
      }
      for (const item of splitTop(stmt.slice(create[0].length, i - 1))) {
        const first = /^("?[\w]+"?)/.exec(item)?.[1];
        if (first && !NOT_COLUMN.has(first.toLowerCase())) push(table, unquote(first));
      }
      continue;
    }
    const alter = /^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w."]+)\s+([\s\S]*)$/i.exec(stmt);
    if (!alter) continue;
    const table = unquote(alter[1]);
    for (const action of splitTop(alter[2])) {
      const add = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?("?\w+"?)/i.exec(action);
      if (add && !NOT_COLUMN.has(unquote(add[1]))) push(table, unquote(add[1]));
      const ren = /^rename\s+(?:column\s+)?(?!to\b|constraint\b)"?\w+"?\s+to\s+("?\w+"?)/i.exec(action);
      if (ren) push(table, unquote(ren[1]));
    }
  }
  return out;
}

/** Найденные колонки ПДн, которых нет ни в реестре, ни в списке «не ПДн»: `таблица.колонка`, без повторов. */
export function unregisteredPdnColumns(found: ReadonlyArray<{ table: string; column: string }>): string[] {
  const known = new Set([...PDN_REGISTRY, ...PDN_NOT_PERSONAL].map((r) => `${r.table}.${r.column}`));
  return [...new Set(found.map((f) => `${f.table}.${f.column}`))].filter((k) => !known.has(k));
}

// ─────────────────────────────── маскирование

const EMAIL = /([A-Za-z0-9!#$%&'*+/=?^_`{|}~.-])[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
// +7 или 8, затем 10 цифр с пробелами, дефисами и скобками кода; не часть более длинного числа или слова
const PHONE = /(?<![\w+])(?:\+7|8)[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?(\d{2})(?!\w)/g;
const SNILS = /(?<!\d)\d{3}-\d{3}-\d{3}[\s-](\d{2})(?!\d)/g;

/** E-mail → a***@домен, телефон РФ → +7***-**-NN, СНИЛС → ***-***-*** NN. Идемпотентна. */
export function maskText(s: string): string {
  return s.replace(SNILS, "***-***-*** $1").replace(PHONE, "+7***-**-$1").replace(EMAIL, "$1***@$2");
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const isV4 = (s: string) => IPV4.test(s) && s.split(".").every((o) => Number(o) <= 255);

/** IPv4 — последний октет 0; IPv4 в IPv6 (::ffff:a.b.c.d) — так же; IPv6 — префикс /48; не адрес — ***. */
export function maskIp(ip: string | null | undefined): string | null {
  if (ip === null || ip === undefined || ip === "") return ip === "" ? "" : null;
  const s = String(ip).trim();
  if (isV4(s)) return s.replace(/\.\d{1,3}$/, ".0");
  const mapped = /^::ffff:(.+)$/i.exec(s);
  if (mapped && isV4(mapped[1])) return `::ffff:${mapped[1].replace(/\.\d{1,3}$/, ".0")}`;
  const h = expandV6(s);
  return h ? `${h.slice(0, 3).join(":")}::/48` : "***";
}

function expandV6(s: string): string[] | null {
  if (!/^[0-9A-Fa-f:]+$/.test(s) || s.split("::").length > 2) return null;
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const missing = 8 - a.length - b.length;
  if (tail === null ? a.length !== 8 : missing < 1) return null;
  const all = [...a, ...Array(tail === null ? 0 : missing).fill("0"), ...b];
  if (all.some((x) => !/^[0-9A-Fa-f]{1,4}$/.test(x))) return null;
  return all.map((x) => parseInt(x, 16).toString(16));
}

// Ключи, значение которых — ПДн целиком (реестр + словарь): в логах только «***»
const FULL_MASK = new Set(["name", "user_name", "full_name", "fio", "login", "customer", "contractor", "user_agent", "ua", "phone", "email", "snils", "passport"]);
const IP_KEYS = new Set(["ip", "ip_address"]);

/** Значение поля лога по имени ключа: ФИО/логин/контрагент/UA — ***, IP — maskIp, прочие строки — maskText. */
export function maskValue(key: string, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  const k = key.toLowerCase();
  if (IP_KEYS.has(k) && typeof v === "string") return maskIp(v);
  if (FULL_MASK.has(k) && (typeof v === "string" || typeof v === "number")) return "***";
  if (typeof v === "string") return maskText(v);
  if (Array.isArray(v)) return v.map((x) => maskValue(key, x));
  if (typeof v === "object") return maskFields(v as Record<string, unknown>);
  return v;
}

/** Все поля структурированного лога — рекурсивно через maskValue. */
export function maskFields(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, maskValue(k, v)]));
}

// Параметры строки запроса без ПДн: пагинация и формат выдачи
const SAFE_QUERY = new Set(["limit", "offset", "page", "format"]);

/** Строка запроса для лога: значения параметров вне белого списка → ***, путь без изменений. */
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const query = url.slice(q + 1);
  if (!query) return url;
  const parts = query.split("&").map((p) => {
    const eq = p.indexOf("=");
    if (eq < 0) return p;
    const k = p.slice(0, eq);
    return SAFE_QUERY.has(k) ? p : `${k}=***`;
  });
  return `${url.slice(0, q)}?${parts.join("&")}`;
}

// ─────────────────────────────── минимизация выдачи

const COUNTERPARTY_ROLES = new Set(["inspector", "supervisor", "admin"]);

/** Застройщика и подрядчика видят роли надзора; ML-инженер и куратор набора — нет (им не нужно для работы). */
export function canSeeCounterparty(role: string): boolean {
  return COUNTERPARTY_ROLES.has(role);
}

export function maskCounterparty<T extends { customer?: string | null; contractor?: string | null }>(o: T, role: string): T {
  if (canSeeCounterparty(role)) return o;
  const m = (v: string | null | undefined) => (v === null || v === undefined || v === "" ? v : "***");
  return { ...o, customer: m(o.customer), contractor: m(o.contractor) };
}

// ─────────────────────────────── срок хранения и обезличивание (ст. 21 ч. 7)

export const anonymizedName = (id: string): string => `Обезличен #${id}`;
export const anonymizedLogin = (id: string): string => `deleted-${id}`;
/** Хеш пароля обезличенной учётки: не формат «соль:хеш» — ни один пароль с ним не совпадёт. */
export const ANONYMIZED_PASSWORD_HASH = "!anonymized";

export interface RetentionConfig {
  userDays: number;
  auditDays: number;
}

/** Какие учётки обезличить (выключены раньше чем now − userDays, ещё не обезличены) и граница обнуления IP/UA в аудите. */
export function retentionPlan(now: Date, users: ReadonlyArray<{ id: string; login: string; deactivated_at: string | null }>, cfg: RetentionConfig): { anonymize: string[]; auditCutoff: string } {
  const userEdge = now.getTime() - cfg.userDays * DAY;
  const anonymize = users
    .filter((u) => u.deactivated_at !== null && !u.login.startsWith("deleted-") && Date.parse(u.deactivated_at) < userEdge)
    .map((u) => u.id);
  return { anonymize, auditCutoff: new Date(now.getTime() - cfg.auditDays * DAY).toISOString() };
}

/** Суточная задача: день UTC, за который её надо выполнить, или null — сегодня уже выполнена. */
export function retentionDue(now: Date, lastDay: string): string | null {
  const day = now.toISOString().slice(0, 10);
  return lastDay >= day ? null : day;
}

// ─────────────────────────────── локализация (ст. 18 ч. 5)

const RU_S3_HOST = "storage.yandexcloud.net";

/** null — хранилище в РФ; иначе текст ошибки старта. Хост сверяется точно (поддомен чужого домена — не РФ). */
export function pdnLocalizationError(endpoint: string, region: string, allow: readonly string[]): string | null {
  let host = "";
  let hostPort = "";
  try {
    const u = new URL(endpoint);
    host = u.hostname.toLowerCase();
    hostPort = u.host.toLowerCase();
  } catch {
    host = "";
  }
  const allowed = allow.map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (host && (host === RU_S3_HOST || host.endsWith(`.${RU_S3_HOST}`))) return null;
  if (host && (allowed.includes(host) || allowed.includes(hostPort))) return null;
  return `INSPECTOR_S3_ENDPOINT=${endpoint} (регион ${region}): персональные данные хранятся только в РФ (152-ФЗ ст. 18 ч. 5) — ` +
    `${RU_S3_HOST} или хост из INSPECTOR_PDN_RU_ENDPOINTS (регион — только настройка клиента, место хранения он не доказывает)`;
}
