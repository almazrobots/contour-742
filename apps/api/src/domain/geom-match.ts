// LNK-06 «Сопоставление элементов» (T-193, ADR-0010): элементы плана двух стадий сводятся в пары по ключу (марка,
// номер помещения, ось) и по положению в координатах здания с допуском. Правила — OS-INSP-3.1.110–3.1.111.
// Одинаковый ключ у нескольких элементов (три двери «Д1») — пары по ближайшему положению; элемент без ключа — только
// по положению и только в пределах допуска и в одной системе координат. Лишнего не угадываем: не нашлось — «только в A/B».
import { dist, type Pt } from "./geom-core.ts";

export interface Matchable {
  key: string;
  at: Pt | null;
  frame: "bld" | "sheet";
}

export interface MatchPair<T> {
  a: T;
  b: T;
  by: "key" | "position";
  shift: number | null; // расстояние между положениями, мм; null — положения нет у одной из сторон или системы разные
}

export interface MatchResult<T> {
  pairs: Array<MatchPair<T>>;
  onlyA: T[];
  onlyB: T[];
}

/** Ключ сопоставления: без регистра, пробелов и точек в конце; латиница, похожая на кириллицу, — кириллицей. */
export function normKey(k: string | null | undefined): string {
  const lat: Record<string, string> = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х" };
  return (k ?? "")
    .normalize("NFC")
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[.]+$/, "")
    .replace(/[ABCEHKMOPTX]/g, (c) => lat[c]);
}

const shiftOf = (a: Matchable, b: Matchable): number | null => (a.at && b.at && a.frame === b.frame ? dist(a.at, b.at) : null);

/** Жадные пары по возрастанию расстояния; при равенстве — по порядку на листе (детерминизм). */
function greedy<T extends Matchable>(as: T[], bs: T[], by: MatchPair<T>["by"], limit: number): { pairs: Array<MatchPair<T>>; restA: T[]; restB: T[] } {
  const cand: Array<{ i: number; j: number; d: number }> = [];
  as.forEach((a, i) =>
    bs.forEach((b, j) => {
      const d = shiftOf(a, b);
      if (by === "position" && (d === null || d > limit)) return;
      cand.push({ i, j, d: d ?? Number.MAX_SAFE_INTEGER });
    }),
  );
  cand.sort((x, y) => x.d - y.d || x.i - y.i || x.j - y.j);
  const ua = new Set<number>();
  const ub = new Set<number>();
  const pairs: Array<MatchPair<T>> = [];
  for (const c of cand) {
    if (ua.has(c.i) || ub.has(c.j)) continue;
    ua.add(c.i);
    ub.add(c.j);
    pairs.push({ a: as[c.i], b: bs[c.j], by, shift: shiftOf(as[c.i], bs[c.j]) });
  }
  return { pairs, restA: as.filter((_, i) => !ua.has(i)), restB: bs.filter((_, j) => !ub.has(j)) };
}

/**
 * LNK-06: сначала ключ (при повторе ключа — ближайшие), затем элементы без ключа или с ключом без пары — по
 * положению в пределах допуска tolMm. Ключи разные у обоих — пара по положению не строится: это другой элемент.
 */
export function matchElements<T extends Matchable>(a: T[], b: T[], tolMm: number): MatchResult<T> {
  if (!(tolMm >= 0)) throw new Error("LNK-06: допуск положения должен быть неотрицательным числом");
  const groups = new Map<string, { a: T[]; b: T[] }>();
  const loose = { a: [] as T[], b: [] as T[] };
  for (const [side, list] of [["a", a], ["b", b]] as const)
    for (const x of list) {
      const k = normKey(x.key);
      if (!k) {
        loose[side].push(x);
        continue;
      }
      const g = groups.get(k) ?? { a: [], b: [] };
      g[side].push(x);
      groups.set(k, g);
    }
  const pairs: Array<MatchPair<T>> = [];
  const restA: T[] = [];
  const restB: T[] = [];
  for (const g of groups.values()) {
    const r = greedy(g.a, g.b, "key", Infinity);
    pairs.push(...r.pairs);
    restA.push(...r.restA);
    restB.push(...r.restB);
  }
  // по положению сводятся только элементы, у которых с одной стороны ключа нет: разные марки — разные элементы
  const pa = [...loose.a, ...restA];
  const pb = [...loose.b, ...restB];
  const byPos = greedy(pa, pb, "position", tolMm).pairs.filter((p) => !normKey(p.a.key) || !normKey(p.b.key));
  pairs.push(...byPos);
  const used = new Set(byPos.flatMap((p) => [p.a, p.b]));
  return { pairs, onlyA: pa.filter((x) => !used.has(x)), onlyB: pb.filter((x) => !used.has(x)) };
}
