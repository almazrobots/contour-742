// Страж настроек безопасности CI (T-060, ревью безопасности 2026-09-26).
// Исключения скана секретов, сам гейт и владельцев кода меняет только владелец репозитория push'ем в main.
//   node scripts/security-guard.mjs <base-sha> <head-sha>
//
// Где страж — граница, а где сигнал:
// - PR: workflow security-guard.yml на pull_request_target — исполняется версия из main, код PR не запускается,
//   сравнивается вся разница base..head PR. Это граница (если PR сливается только после зелёной проверки).
// - push: шаг в ci-gate.yml исполняется ИЗ ПУШНУТОГО коммита — пушащий может удалить шаг или подменить скрипт.
//   Здесь страж — только сигнал (красный гейт после факта). Запрет прямого push в main даёт только защита веток
//   на сервере GitHub (у приватного репо — тариф Team) или договорённость работать через PR.
import { execFileSync } from "node:child_process";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

/** Файлы, правка которых ослабляет гейт или скан секретов. Регистр не важен: на macOS/Windows «.GitHub» — та же папка. */
export const PROTECTED = [
  /^\.gitleaks/i, // .gitleaksignore, .gitleaks.toml и любые варианты конфигурации
  /^\.github\//i,
  /^(docs\/)?codeowners$/i, // CODEOWNERS действует и из корня, и из docs/
  /^scripts\/security-guard\.mjs$/i,
];
export const INLINE_ALLOW = "gitleaks:allow";

export const isProtected = (path) => PROTECTED.some((re) => re.test(posix.normalize(path).replace(/^\.\//, "")));

/**
 * Нарушения: изменённые защищённые файлы; символические ссылки, изменённые или добавленные (ссылка на защищённый
 * файл обходит список путей — поэтому любая новая ссылка только через владельца); рост числа gitleaks:allow в файле.
 */
export function violations({ files, symlinks = [], allowAdded = [], allowBefore = new Map(), allowAfter = new Map() }) {
  const out = files.filter(isProtected).map((f) => `изменён защищённый файл: ${f}`);
  for (const s of symlinks) out.push(`добавлена или изменена символическая ссылка: ${s}`);
  // главное — добавленная строка с пометкой: перенос пометки на строку с секретом не меняет счётчик файла
  const flagged = new Set(allowAdded);
  for (const [f, n] of allowAfter) if (n > (allowBefore.get(f) ?? 0)) flagged.add(f); // и рост счётчика — сигнал
  for (const f of flagged) out.push(`добавлено исключение ${INLINE_ALLOW}: ${f}`);
  return out;
}

/**
 * Файлы с добавленными строками, содержащими пометку. Разбор по состоянию: до первого «@@» файла — заголовок
 * (diff --git, ---, +++), внутри блока любая строка с «+» — добавленный текст, даже «+++…» (строка «++ x»).
 */
export function addedAnnotated(patch) {
  const out = new Set();
  let file = null;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
    } else if (!inHunk && line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "");
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+") && line.toLowerCase().includes(INLINE_ALLOW)) {
      out.add(file ?? "(имя файла не разобрано)"); // нарушение — сама строка; имя только для сообщения
    }
  }
  return [...out];
}

// Вывод git не зависит от настроек пользователя и раннера: без экранирования имён, без цвета, внешних diff и
// нестандартных префиксов (diff.noprefix / diff.mnemonicPrefix меняют «b/» в заголовках)
const GIT_CFG = ["-c", "core.quotepath=off", "-c", "color.ui=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.external="];
const git = (...args) => execFileSync("git", [...GIT_CFG, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

/** Счётчики gitleaks:allow по файлам ревизии (без учёта регистра, как читает gitleaks). */
function allowCounts(rev) {
  let out = "";
  try {
    out = git("grep", "-z", "-c", "-i", "-F", INLINE_ALLOW, rev, "--");
  } catch (e) {
    if (e.status === 1) return new Map(); // совпадений нет
    throw e;
  }
  const m = new Map();
  // формат с -z: «rev:путь\0число\n»
  for (const rec of out.split("\n").filter(Boolean)) {
    const [name, count] = rec.split("\0");
    m.set(name.slice(rev.length + 1), Number(count));
  }
  return m;
}

/** Разница base..head целиком. Неясная или отсутствующая база — исключение (отказ, а не пропуск). */
export function diffOf(base, head) {
  if (!/^[0-9a-f]{40}$/.test(base ?? "") || /^0{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(head ?? "")) {
    throw new Error(`неясная база сравнения: base=${base || "—"} head=${head || "—"}`);
  }
  git("cat-file", "-e", `${base}^{commit}`);
  git("cat-file", "-e", `${head}^{commit}`);
  // -z и без переименований: имя без экранирования, переименование видно как удаление старого и добавление нового
  const files = git("diff", "--name-only", "-z", "--no-renames", base, head).split("\0").filter(Boolean);
  // --raw: «:старый_режим новый_режим …\0путь\0»; режим 120000 — символическая ссылка
  const raw = git("diff", "--raw", "-z", "--no-renames", base, head).split("\0").filter(Boolean);
  const symlinks = [];
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i].split(" ")[1] === "120000") symlinks.push(raw[i + 1]);
  // кандидатов отбирает git (-G: строки с пометкой добавлены или удалены), разбор — addedAnnotated
  const patch = git("diff", "--unified=0", "--no-color", "--no-ext-diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", "-i", `-G${INLINE_ALLOW}`, base, head);
  return { files, symlinks, allowAdded: addedAnnotated(patch), allowBefore: allowCounts(base), allowAfter: allowCounts(head) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [base, head] = process.argv.slice(2);
  try {
    const bad = violations(diffOf(base, head));
    for (const v of bad) console.log(`::error::${v} — меняет только владелец репозитория push'ем в main`);
    process.exit(bad.length ? 1 : 0);
  } catch (e) {
    console.log(`::error::страж безопасности: ${e.message} — отказ`);
    process.exit(1);
  }
}
