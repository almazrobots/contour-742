// T-133: просмотр листа не должен тянуть весь PDF — чертёж «Алтуфьево» на 40 МБ через VPN шёл 73 с ради одной страницы.
// pdf.js запрашивает файл кусками (Range: bytes=a-b) и сам берёт только нужные страницы. Один диапазон; несколько
// диапазонов и чушь — отдаём файл целиком (RFC 9110 §14.2 разрешает игнорировать Range).

export type ByteRange = { start: number; end: number } | "unsatisfiable" | null;

export function parseRange(header: string | undefined, size: number): ByteRange {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    // суффикс: последние N байт
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}
