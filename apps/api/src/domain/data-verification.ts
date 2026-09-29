import { createHash } from "node:crypto";
import { z } from "zod";

const Sha = z.string().regex(/^[a-f0-9]{64}$/);
const Box = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)])
  .refine((b) => b[0] < b[2] && b[1] < b[3], "Пустая или перевёрнутая рамка");
export const AnnotationSide = z.object({
  sha256: Sha, file_name: z.string().min(1).max(600), kind: z.enum(["pdf", "image", "jpg", "png", "tif", "docx", "xlsx", "xml"]),
  page: z.number().int().min(1).max(100000), bbox: Box.nullable().default(null), anchor_bbox: Box.nullable().default(null),
  value: z.string().max(2000).default(""), quote: z.string().max(4000).default(""),
  object_key: z.string().min(1).max(200), stage: z.enum(["PD", "RD", "ID"]).nullable().default(null),
  file_id: z.string().max(100).nullable().default(null), inspection_id: z.string().max(100).nullable().default(null),
  revision: z.string().max(100).nullable().default(null), artifact_sha256: Sha.nullable().default(null),
  geometry: z.enum(["word", "coarse_band", "none"]).default("word"),
  crop: z.object({ page: z.number().int().positive(), band: z.number().int().min(0).max(3), sha256:Sha }).nullable().default(null),
  preview: z.object({key:Sha,sha256:Sha,label:z.string().min(1).max(600),revision:z.literal('structured-original.v1')}).strict().nullable().optional(),
  provenance: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((s,ctx) => {
  if (s.crop && s.crop.page !== s.page) ctx.addIssue({code:"custom",message:"Страница фрагмента отличается от оригинала"});
  if(s.preview && (!['docx','xlsx','xml'].includes(s.kind)||s.crop||s.bbox||s.anchor_bbox))ctx.addIssue({code:'custom',message:'Текстовое представление требует структурированного оригинала без растровой геометрии'});
});
export const AnnotationTaskInput = z.object({
  parameter: z.string().regex(/^M-(?:00[1-9]|0[1-9]\d|1[0-2]\d|13[0-2])$/),
  operation: z.enum(["reading", "field_match", "comparison", "missing"]),
  sides: z.array(AnnotationSide).min(1).max(2),
  difficulty: z.enum(["ordinary", "hard", "control"]).default("ordinary"),
  source_version: z.string().min(1).max(200).default("unknown"),
}).strict().superRefine((t, ctx) => {
  const pair = t.operation === "field_match" || t.operation === "comparison";
  if (t.sides.length !== (pair ? 2 : 1)) ctx.addIssue({ code: "custom", message: "Число сторон не соответствует операции" });
  if (pair && t.sides[0].object_key !== t.sides[1].object_key) ctx.addIssue({ code: "custom", message: "Разные объекты: связь не доказана" });
  if (JSON.stringify(t).length > 20000) ctx.addIssue({ code: "custom", message: "Слишком большой контекст" });
});
export type AnnotationTask = z.infer<typeof AnnotationTaskInput>;
export type AnnotationSource = z.infer<typeof AnnotationSide>;
export const AnnotationAnswer = z.object({
  token: z.string().min(20).max(100), idempotency_key: z.string().min(16).max(100),
  answer: z.enum(["YES", "NO", "UNSURE"]), comment: z.string().max(2000).default(""),
  corrected_value: z.string().max(2000).nullable().default(null),
}).strict().refine(a=>a.corrected_value===null||a.answer==='NO',"Исправление значения требует ответа Нет");
export type AnnotationResponse = z.infer<typeof AnnotationAnswer>;
export function annotationInterval(successes:number,total:number) {
  if(!Number.isSafeInteger(successes)||!Number.isSafeInteger(total)||successes<0||total<successes)throw new RangeError("Некорректный размер выборки");
  if(!total)return null;
  const z=1.959963984540054,p=successes/total,denominator=1+z*z/total;
  const center=(p+z*z/(2*total))/denominator;
  const half=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/denominator;
  return {n:total,rate:p,low:Math.max(0,center-half),high:Math.min(1,center+half),method:"wilson_95"};
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function annotationFingerprint(task: AnnotationTask): string { return hash(JSON.stringify(task)); }
export function annotationQuestion(task: AnnotationTask): string {
  if (task.operation === "field_match") return "Выделенные поля в двух документах обозначают один и тот же признак?";
  if (task.operation === "comparison") return "Значения в двух выделенных полях совпадают?";
  if (task.operation === "missing") return "На показанном фрагменте есть указанное поле?";
  return `В выделенном фрагменте действительно указано «${task.sides[0].value}»?`;
}
export function chooseAnnotationParameter(rows: Array<{ parameter: string; ready: number; answered: number }>, mode: "ordinary" | "undercovered", random: number): string | null {
  const weights = rows.filter((r) => r.ready > 0).map((r) => ({ parameter: r.parameter, weight: mode === "undercovered" ? 1 / (1 + r.answered) : 1 }));
  let at = Math.max(0, Math.min(.999999, random)) * weights.reduce((n, r) => n + r.weight, 0);
  for (const row of weights) { at -= row.weight; if (at < 0) return row.parameter; }
  return weights.at(-1)?.parameter ?? null;
}
export type AnnotationStratum = { object_key:string; operation:string; verified_sources:number; recent:number; object_recent?:number };
export function chooseAnnotationStratum(rows:AnnotationStratum[], undercovered:boolean, objectRandom:number, operationRandom:number):AnnotationStratum|null {
  const pick = <T>(items:Array<{value:T;weight:number}>,random:number):T|null => {
    let at=Math.max(0,Math.min(.999999,random))*items.reduce((n,r)=>n+r.weight,0);
    for(const row of items){at-=row.weight;if(at<0)return row.value;}
    return items.at(-1)?.value??null;
  };
  const objects=new Map<string,{verified:number;recent:number}>();
  for(const row of rows){const n=objects.get(row.object_key)??{verified:0,recent:0};n.verified+=row.verified_sources;n.recent=row.object_recent===undefined?n.recent+row.recent:Math.max(n.recent,row.object_recent);objects.set(row.object_key,n);}
  const object=pick([...objects].map(([value,n])=>({value,weight:1/((1+n.recent)*(undercovered?1+n.verified:1))})),objectRandom);
  return pick(rows.filter(r=>r.object_key===object).map(value=>({value,weight:1/((1+value.recent)*(undercovered?1+value.verified_sources:1))})),operationRandom);
}
export function splitAnnotationGroups(rows: Array<{ id: string; object_key: string; shas: string[] }>): Record<string, { group: string; split: "train" | "validation" | "test" }> {
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x); if (!p) { parent.set(x, x); return x; } if (p === x) return x; const root = find(p); parent.set(x, root); return root; };
  const shaObjects = new Map<string, string>();
  for (const row of rows) {
    find(row.object_key);
    for (const sha of row.shas) { const other = shaObjects.get(sha); if (other) { const a = find(row.object_key), b = find(other); parent.set(a < b ? b : a, a < b ? a : b); } else shaObjects.set(sha, row.object_key); }
  }
  return Object.fromEntries(rows.map((r) => { const group = find(r.object_key); const n = parseInt(hash(group).slice(0, 8), 16) % 100; return [r.id, { group, split: n < 70 ? "train" : n < 85 ? "validation" : "test" }]; }));
}
