#!/usr/bin/env node
// Гейт T-107 (ADR-0003): «висящий» промис — вызов async-функции без await/return/void. После перехода на асинхронный
// слой данных это главный класс тихих дефектов: запись в базу уходит мимо транзакции, ошибка теряется, порядок
// операций плывёт. tsc такое не ловит — ловим компилятором TypeScript по типам.
//   node scripts/check-floating-promises.mjs            проверить apps/api/src
//   node scripts/check-floating-promises.mjs <файлы…>   проверить указанные файлы (для самопроверки гейта)
// Выход 1 и список «файл:строка» — есть висящие промисы.
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const api = join(root, "apps/api");
const ts = createRequire(join(api, "package.json"))("typescript");

const cfgPath = join(api, "tsconfig.json");
const cfg = ts.parseJsonConfigFileContent(ts.readConfigFile(cfgPath, ts.sys.readFile).config, ts.sys, api);
const only = process.argv.slice(2).map((f) => resolve(f));
const program = ts.createProgram(only.length ? only : cfg.fileNames, { ...cfg.options, noEmit: true });
const checker = program.getTypeChecker();

function isPromise(type) {
  if (!type) return false;
  if (type.isUnion()) return type.types.some(isPromise);
  // Только настоящие Promise: thenable-объекты фреймворков (FastifyReply, FastifyInstance) ждать не обязательно
  const sym = type.getSymbol() ?? type.aliasSymbol;
  return Boolean(sym && (sym.getName() === "Promise" || sym.getName() === "PromiseLike"));
}

const found = [];
function visit(node, sf) {
  // выражение-оператор: f(); obj.m(); — результат выброшен
  if (ts.isExpressionStatement(node)) {
    let e = node.expression;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    const discarded = !ts.isVoidExpression(e) && !ts.isAwaitExpression(e) && !ts.isBinaryExpression(e) && !ts.isYieldExpression(e);
    if (discarded && (ts.isCallExpression(e) || ts.isNewExpression(e) || ts.isPropertyAccessExpression(e)) && isPromise(checker.getTypeAtLocation(e))) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push(`${relative(root, sf.fileName)}:${line + 1}  ${node.getText(sf).split("\n")[0].slice(0, 110)}`);
    }
  }
  // arr.forEach(async …) — промисы теряются всегда
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "forEach") {
    const cb = node.arguments[0];
    if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      found.push(`${relative(root, sf.fileName)}:${line + 1}  forEach(async …) — промисы теряются`);
    }
  }
  ts.forEachChild(node, (n) => visit(n, sf));
}

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile || sf.fileName.includes("node_modules")) continue;
  if (!only.length && !sf.fileName.startsWith(join(api, "src"))) continue;
  visit(sf, sf);
}

if (found.length) {
  console.error(`висящие промисы: ${found.length} (await, return или явный void с .catch)\n` + found.join("\n"));
  process.exit(1);
}
console.log("висящих промисов нет");
