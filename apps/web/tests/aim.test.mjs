// Прицел (T-106, Н1) и клавиатура экрана верификации — чистые функции, без браузера.
//   node --test apps/web/tests/aim.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { aimWindow, toLocal, renderScale, keyAction } from "../src/lib/aim.ts";

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const inUnit = (w) => w.every((v) => v >= 0 && v <= 1);

test("окно прицела содержит рамку с полем и не выходит за лист", () => {
  const w = aimWindow([[0.4, 0.4, 0.5, 0.45]]);
  assert.ok(inUnit(w));
  assert.ok(w[0] < 0.4 && w[2] > 0.5 && w[1] < 0.4 && w[3] > 0.45, "рамка внутри окна с полем");
  near((w[0] + w[2]) / 2, 0.45, 1e-6); // центр окна — центр рамки
});

test("крошечная рамка получает окно не уже минимальной ширины листа", () => {
  const w = aimWindow([[0.5, 0.5, 0.501, 0.501]], { minW: 0.12 });
  near(w[2] - w[0], 0.12, 1e-9);
});

test("рамка в углу листа: окно сдвигается внутрь, а не обрезается", () => {
  const w = aimWindow([[0.97, 0.97, 0.995, 0.99]], { minW: 0.2 });
  assert.ok(inUnit(w));
  near(w[2], 1);
  near(w[2] - w[0], 0.2, 1e-9);
  assert.ok(w[0] <= 0.97 && w[1] <= 0.97, "рамка остаётся видна");
});

test("окно держит пропорцию области показа", () => {
  const w = aimWindow([[0.3, 0.3, 0.4, 0.32]], { aspect: 2 });
  near((w[2] - w[0]) / (w[3] - w[1]), 2, 1e-9);
});

test("огромная рамка — окно равно всему листу", () => {
  assert.deepEqual(aimWindow([[0, 0, 1, 1]]), [0, 0, 1, 1]);
});

test("несколько рамок одного листа — окно охватывает все", () => {
  const w = aimWindow([[0.1, 0.1, 0.12, 0.12], [0.3, 0.2, 0.32, 0.22]]);
  assert.ok(w[0] <= 0.1 && w[2] >= 0.32 && w[1] <= 0.1 && w[3] >= 0.22);
});

test("окно расширяется влево на подпись строки: значение справа в кадре, название строки слева", () => {
  const box = [0.6, 0.4, 0.66, 0.42];
  const plain = aimWindow([box], { minW: 0.1 });
  const led = aimWindow([box], { minW: 0.1, lead: 2.5 });
  assert.ok(led[0] < plain[0] - 0.1, "левая граница ушла на ширину подписи");
  assert.ok(led[2] >= box[2], "значение по-прежнему целиком в кадре");
  assert.ok(inUnit(led));
});

test("широкая область (изменение листа) запаса слева не получает", () => {
  const wide = [0.1, 0.3, 0.9, 0.45];
  assert.deepEqual(aimWindow([wide], { lead: 4 }), aimWindow([wide]));
});

test("нет годной рамки — прицела нет (показ всего листа)", () => {
  assert.equal(aimWindow([]), null);
  assert.equal(aimWindow([null, undefined]), null);
  assert.equal(aimWindow([[0.5, 0.5, 0.4, 0.6]]), null, "x1 < x0 — битая рамка");
  assert.equal(aimWindow([[NaN, 0, 1, 1]]), null);
});

test("координаты рамки внутри окна — доли окна", () => {
  const l = toLocal([0.4, 0.4, 0.5, 0.5], [0.3, 0.3, 0.7, 0.7]);
  near(l[0], 0.25); near(l[1], 0.25); near(l[2], 0.5); near(l[3], 0.5);
});

test("масштаб рендера: окно заполняет ширину показа, но не раздувает холст", () => {
  near(renderScale(1000, 0.1, 800), 8); // 100 pt окна → 800 px
  assert.equal(renderScale(1000, 0.001, 800), 12, "потолок масштаба");
  assert.equal(renderScale(1000, 1, 200), 1, "пол масштаба");
  assert.equal(renderScale(0, 0.1, 800), 1, "битый размер страницы — безопасный масштаб");
});

test("клавиши работают по физической клавише — в ЙЦУКЕН так же, как в QWERTY", () => {
  // в русской раскладке J даёт key «о», но code остаётся KeyJ
  assert.deepEqual(keyAction({ code: "KeyJ", key: "о" }, "idle"), { type: "next" });
  assert.deepEqual(keyAction({ code: "KeyK", key: "л" }, "idle"), { type: "prev" });
  assert.deepEqual(keyAction({ code: "ArrowDown", key: "ArrowDown" }, "idle"), { type: "next" });
  assert.deepEqual(keyAction({ code: "Digit1", key: "!" }, "idle"), { type: "confirm" });
  assert.deepEqual(keyAction({ code: "Numpad2", key: "2" }, "idle"), { type: "reject" });
  assert.deepEqual(keyAction({ code: "Digit3", key: "3" }, "idle"), { type: "clarify" });
  assert.equal(keyAction({ code: "KeyQ", key: "й" }, "idle"), null);
  assert.deepEqual(keyAction({ code: "KeyZ", key: "я" }, "idle"), { type: "undo" }, "Z в русской раскладке — «я»");
});

test("в выборе причины цифра выбирает причину, Enter применяет, Esc отменяет", () => {
  assert.deepEqual(keyAction({ code: "Digit4", key: "4" }, "reasons"), { type: "reason", index: 3 });
  assert.deepEqual(keyAction({ code: "Numpad1", key: "1" }, "reasons"), { type: "reason", index: 0 });
  assert.deepEqual(keyAction({ code: "Enter", key: "Enter" }, "reasons"), { type: "submit" });
  assert.deepEqual(keyAction({ code: "Escape", key: "Escape" }, "reasons"), { type: "cancel" });
  assert.equal(keyAction({ code: "KeyJ", key: "j" }, "reasons"), null, "листать во время выбора причины нельзя");
});

test("клавиши с модификаторами не перехватываются (Cmd+1, Ctrl+J)", () => {
  assert.equal(keyAction({ code: "Digit1", key: "1", metaKey: true }, "idle"), null);
  assert.equal(keyAction({ code: "KeyJ", key: "j", ctrlKey: true }, "idle"), null);
});
