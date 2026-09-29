// Геометрия плана на чистом TypeScript (T-193, ADR-0010 п. 2): площадь, разбиение на треугольники, пересечение и IoU,
// Хаусдорф, расстояния, точка в полигоне, пересечения ломаной с отрезками, перевод в оси здания. Без зависимостей:
// объёмы — сотни полигонов на лист. Вырожденный вход (меньше трёх точек, не число, нулевая площадь, самопересечение) —
// громкий отказ: операция бросает ошибку, оператор ставит NOT_COMPARABLE, а не сравнивает ноль.
// Правила — OS-INSP-2.4.45–2.4.47 (CMP-13, CMP-15, CMP-16).

export type Pt = [number, number];
export type Seg = [Pt, Pt];
/** Аффинная матрица перевода листа в оси здания (NRM-09), порядок матрицы PDF (ADR-0010): x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Frame = [number, number, number, number, number, number];

const EPS = 1e-9;

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const cross = (o: Pt, a: Pt, b: Pt): number => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const dist2 = (a: Pt, b: Pt): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
export const dist = (a: Pt, b: Pt): number => Math.sqrt(dist2(a, b));

/** Контур без замыкающей точки: [A, B, C, A] → [A, B, C]. */
function open(poly: Pt[]): Pt[] {
  if (poly.length > 1 && poly[0][0] === poly[poly.length - 1][0] && poly[0][1] === poly[poly.length - 1][1]) return poly.slice(0, -1);
  return poly;
}

function rawSignedArea(p: Pt[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/** Отрезки пересекаются во внутренней точке (общие концы соседних рёбер не считаются). */
function properCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

/** Причина, по которой контур не полигон, словами; null — полигон годен (OS-INSP-2.4.45). */
export function validPolygon(poly: Pt[] | null | undefined): string | null {
  if (!Array.isArray(poly)) return "контура нет";
  const p = open(poly);
  if (p.length < 3) return `в контуре меньше трёх точек (${p.length})`;
  if (p.some((q) => !Array.isArray(q) || q.length !== 2 || !Number.isFinite(q[0]) || !Number.isFinite(q[1]))) return "координата контура — не число";
  // соседние рёбра делят вершину, а касание концом properCross не считает — отдельный пропуск соседей не нужен
  for (let i = 0; i < p.length; i++)
    for (let j = i + 1; j < p.length; j++) if (properCross(p[i], p[(i + 1) % p.length], p[j], p[(j + 1) % p.length])) return "контур самопересекается";
  if (Math.abs(rawSignedArea(p)) <= EPS) return "контур нулевой площади (точки на одной прямой)";
  return null;
}

function must(poly: Pt[]): Pt[] {
  const why = validPolygon(poly);
  if (why) throw new Error(`полигон: ${why}`);
  return open(poly);
}

/** Ориентированная площадь: > 0 — обход против часовой стрелки (в осях с y вверх). */
export function signedArea(poly: Pt[]): number {
  return rawSignedArea(must(poly));
}

/** Площадь контура — формула шнурования (CMP-13). */
export function polygonArea(poly: Pt[]): number {
  return Math.abs(signedArea(poly));
}

/** Точка внутри полигона или на его границе (луч вправо, граница — внутри). */
export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  const p = open(poly);
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if (segmentDistance(pt, p[j], p[i]) <= EPS) return true;
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Разбиение простого (в т. ч. невыпуклого) полигона на треугольники отсечением ушей. Нужен для пересечения
 * невыпуклых контуров: треугольники двух разбиений пересекаются как выпуклые, суммы площадей складываются.
 */
export function triangulate(poly: Pt[]): Pt[][] {
  let p = must(poly);
  if (rawSignedArea(p) < 0) p = [...p].reverse();
  // точки посреди прямого участка (стык сегментов стены) ухом не бывают — убираются до разбиения, иначе оно не сходится
  p = p.filter((b, i) => {
    const a = p[(i + p.length - 1) % p.length];
    const c = p[(i + 1) % p.length];
    return Math.abs(cross(a, b, c)) > 1e-10 * dist(a, b) * dist(b, c);
  });
  const idx = p.map((_, i) => i);
  const out: Pt[][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10_000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const a = p[idx[(k + idx.length - 1) % idx.length]];
      const b = p[idx[k]];
      const c = p[idx[(k + 1) % idx.length]];
      if (cross(a, b, c) <= EPS) continue; // вогнутая вершина или вырожденная тройка — не ухо
      const blocked = idx.some((j) => {
        const q = p[j];
        if (q === a || q === b || q === c) return false;
        return cross(a, b, q) >= -EPS && cross(b, c, q) >= -EPS && cross(c, a, q) >= -EPS;
      });
      if (blocked) continue;
      out.push([a, b, c]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) throw new Error("полигон: разбиение на треугольники не сходится");
  }
  out.push(idx.map((i) => p[i]));
  return out;
}

/** Отсечение выпуклого многоугольника выпуклым (Сазерленд — Ходжман); оба — против часовой. */
function clipConvex(subject: Pt[], clip: Pt[]): Pt[] {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const inp = out;
    out = [];
    for (let j = 0; j < inp.length; j++) {
      const cur = inp[j];
      const prev = inp[(j + inp.length - 1) % inp.length];
      const cin = cross(a, b, cur) >= -EPS;
      const pin = cross(a, b, prev) >= -EPS;
      if (cin) {
        if (!pin) out.push(lineHit(prev, cur, a, b));
        out.push(cur);
      } else if (pin) out.push(lineHit(prev, cur, a, b));
    }
  }
  return out;
}

function lineHit(p: Pt, q: Pt, a: Pt, b: Pt): Pt {
  const r = sub(q, p);
  const s = sub(b, a);
  const den = r[0] * s[1] - r[1] * s[0];
  const t = ((a[0] - p[0]) * s[1] - (a[1] - p[1]) * s[0]) / den;
  return [p[0] + t * r[0], p[1] + t * r[1]];
}

/** Площадь пересечения двух простых полигонов: сумма пересечений треугольников разбиений (CMP-15). */
export function intersectionArea(a: Pt[], b: Pt[]): number {
  const ta = triangulate(a);
  const tb = triangulate(b);
  let s = 0;
  for (const x of ta)
    for (const y of tb) {
      const c = clipConvex(x, y);
      s += Math.abs(rawSignedArea(c)); // пусто или отрезок — площадь 0
    }
  return s;
}

/** IoU — площадь пересечения к площади объединения (CMP-15). */
export function iou(a: Pt[], b: Pt[]): number {
  const inter = intersectionArea(a, b);
  // объединение валидных полигонов не бывает нулевым: площадь каждого > 0 (validPolygon)
  return inter / (polygonArea(a) + polygonArea(b) - inter);
}

/** Расстояние от точки до отрезка. */
export function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const l2 = dist2(a, b);
  if (l2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2));
  return dist(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
}

/** Рёбра замкнутого контура; у точки — один отрезок нулевой длины, у отрезка — он же дважды. */
const edges = (p: Pt[]): Seg[] => p.map((q, i) => [q, p[(i + 1) % p.length]] as Seg);

function toBoundary(pt: Pt, segs: Seg[]): number {
  let m = Infinity;
  for (const [a, b] of segs) m = Math.min(m, segmentDistance(pt, a, b));
  return m;
}

/**
 * Хаусдорф между границами контуров (CMP-15). Рёбра сгущаются точками с шагом не больше step (по умолчанию —
 * 1/200 наибольшего габарита): отклонение посреди ребра не теряется, погрешность — не больше половины шага.
 */
export function hausdorff(a: Pt[], b: Pt[], step?: number): number {
  if (!a?.length || !b?.length) throw new Error("Хаусдорф: пустой контур");
  const pa = open(a);
  const pb = open(b);
  const all = [...pa, ...pb];
  const span = Math.max(Math.max(...all.map((p) => p[0])) - Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1])) - Math.min(...all.map((p) => p[1])));
  const h = step ?? Math.max(span / 200, EPS);
  const sa = edges(pa);
  const sb = edges(pb);
  const directed = (src: Seg[], pts: Pt[], dst: Seg[]) => {
    let m = 0;
    for (const p of pts) m = Math.max(m, toBoundary(p, dst));
    for (const [x, y] of src) {
      const n = Math.ceil(dist(x, y) / h);
      for (let i = 1; i < n; i++) m = Math.max(m, toBoundary([x[0] + ((y[0] - x[0]) * i) / n, x[1] + ((y[1] - x[1]) * i) / n], dst));
    }
    return m;
  };
  return Math.max(directed(sa, pa, sb), directed(sb, pb, sa));
}

/** Точка пересечения отрезков (включая касание концом) или null. */
export function segmentHit(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) <= EPS) return null; // параллельны: наложение трассы на стену пересечением не считается
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}

/** Расстояние между фигурами (точка, ломаная из двух точек, полигон): 0 при пересечении и вложении (CMP-16). */
export function distance(a: Pt[], b: Pt[]): number {
  const pa = open(a);
  const pb = open(b);
  if (pa.length >= 3 && pb.some((p) => pointInPolygon(p, pa))) return 0;
  if (pb.length >= 3 && pa.some((p) => pointInPolygon(p, pb))) return 0;
  const sa = edges(pa);
  const sb = edges(pb);
  let m = Infinity;
  for (const [x, y] of sa)
    for (const [u, v] of sb) {
      if (segmentHit(x, y, u, v)) return 0;
      m = Math.min(m, segmentDistance(x, u, v), segmentDistance(y, u, v), segmentDistance(u, x, y), segmentDistance(v, x, y));
    }
  return m;
}

/** Точки пересечения ломаной (трассы) с отрезками (преградами) и номер отрезка — по порядку трассы (CMP-16, M-111). */
export function polylineCrossings(line: Pt[], segs: Seg[]): Array<{ at: Pt; seg: number }> {
  const out: Array<{ at: Pt; seg: number }> = [];
  for (let i = 0; i + 1 < line.length; i++)
    segs.forEach(([c, d], k) => {
      const hit = segmentHit(line[i], line[i + 1], c, d);
      if (hit && !out.some((o) => o.seg === k && dist(o.at, hit) <= 1e-6)) out.push({ at: hit, seg: k });
    });
  return out;
}

/** Перевод точки листа в оси здания (NRM-09). */
export function applyFrame(p: Pt, [a, b, c, d, e, f]: Frame): Pt {
  return [a * p[0] + c * p[1] + e, b * p[0] + d * p[1] + f];
}
