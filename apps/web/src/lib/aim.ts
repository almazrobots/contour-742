// Прицел (T-106, ноу-хау Н1): лист открывается сразу на доказательстве, а не целиком.
// Окно прицела — объединение рамок листа с полем, чтобы в кадр попали соседние строки, оси и подписи.
// Координаты везде — доли [0;1] видимой страницы, как bbox из OS-INSP-2.2.2.
// Файл без JSX и без импортов: его проверяет node --test (apps/web/tests/aim.test.mjs).

export type Box = [number, number, number, number];

export interface AimOptions {
  /** поле вокруг рамки — доля размера рамки с каждой стороны */
  margin?: number;
  /** минимальная ширина окна — доля ширины листа, чтобы был виден контекст */
  minW?: number;
  /** пропорция окна (ширина / высота) в долях листа; не задана — по рамке */
  aspect?: number;
  /** запас слева в ширинах рамки — чтобы в кадр попало название строки таблицы слева от значения */
  lead?: number;
}

const valid = (b: unknown): b is Box =>
  Array.isArray(b) && b.length === 4 && b.every((v) => typeof v === "number" && Number.isFinite(v)) && b[2] > b[0] && b[3] > b[1];

/** Окно прицела по рамкам листа. Нет ни одной годной рамки — null: показываем лист целиком. */
export function aimWindow(boxes: ReadonlyArray<Box | null | undefined>, { margin = 0.35, minW = 0.12, aspect, lead = 0 }: AimOptions = {}): Box | null {
  const ok = boxes.filter(valid);
  if (!ok.length) return null;
  const bx0 = Math.min(...ok.map((b) => b[0]));
  const bw = Math.max(...ok.map((b) => b[2])) - bx0;
  // запас слева нужен узкой рамке-значению (подпись строки левее); широкой области изменений — нет
  const x0 = bw < 0.2 ? Math.max(bx0 - lead * bw, 0) : bx0;
  const y0 = Math.min(...ok.map((b) => b[1]));
  const x1 = Math.max(...ok.map((b) => b[2]));
  const y1 = Math.max(...ok.map((b) => b[3]));
  let w = Math.max((x1 - x0) * (1 + 2 * margin), minW);
  let h = (y1 - y0) * (1 + 2 * margin);
  if (aspect && aspect > 0) {
    if (w / h < aspect) w = h * aspect;
    else h = w / aspect;
  }
  w = Math.min(w, 1);
  h = Math.min(h, 1);
  // центр — центр рамок; окно сдвигается внутрь листа, а не обрезается
  const clamp = (c: number, size: number) => Math.min(Math.max(c - size / 2, 0), 1 - size);
  const left = clamp((x0 + x1) / 2, w);
  const top = clamp((y0 + y1) / 2, h);
  return [left, top, left + w, top + h];
}

/** Рамка листа в долях окна прицела — чтобы наложить её на отрисованное окно. */
export function toLocal(b: Box, win: Box): Box {
  const w = win[2] - win[0];
  const h = win[3] - win[1];
  return [(b[0] - win[0]) / w, (b[1] - win[1]) / h, (b[2] - win[0]) / w, (b[3] - win[1]) / h];
}

/** Масштаб рендера pdf.js: окно шириной winW (доля листа) заполняет targetPx пикселей холста.
 *  Потолок 12 — чтобы холст не раздувался на крошечной рамке; пол 1. */
export function renderScale(pageWidth: number, winW: number, targetPx: number): number {
  if (!(pageWidth > 0) || !(winW > 0) || !(targetPx > 0)) return 1;
  return Math.min(Math.max(targetPx / (pageWidth * winW), 1), 12);
}

export type KeyAct =
  | { type: "next" | "prev" | "confirm" | "reject" | "clarify" | "submit" | "cancel" | "undo" }
  | { type: "reason"; index: number };

interface KeyLike {
  code: string;
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/** Клавиши экрана верификации — по физической клавише (KeyboardEvent.code), поэтому работают
 *  и в русской раскладке: там J даёт key «о», но code остаётся KeyJ. */
export function keyAction(e: KeyLike, mode: "idle" | "reasons"): KeyAct | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  const digit = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  if (mode === "reasons") {
    if (digit) return { type: "reason", index: Number(digit[1]) - 1 };
    if (e.code === "Enter" || e.code === "NumpadEnter") return { type: "submit" };
    if (e.code === "Escape") return { type: "cancel" };
    return null;
  }
  if (e.code === "KeyJ" || e.code === "ArrowDown") return { type: "next" };
  if (e.code === "KeyK" || e.code === "ArrowUp") return { type: "prev" };
  if (digit?.[1] === "1") return { type: "confirm" };
  if (digit?.[1] === "2") return { type: "reject" };
  if (digit?.[1] === "3") return { type: "clarify" };
  if (e.code === "KeyZ") return { type: "undo" }; // вернуть последнее решение (OS-INSP-4.1.15)
  return null;
}
