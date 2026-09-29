// Полоса стадий ПД → РД → ИД (OS-INSP-4.1.22, T-132): у каждой стадии — значение, документ и страница, сколько
// упоминаний найдено и сколько отсеяно; нет значения — почему: показателя нет в загруженных документах или стадия не
// загружена вовсе. Инспектор сразу видит, с чем сравнивали и чего не хватает. Щелчок — лист упоминания стадии.
import type { ProvMention } from "./ClassMentions";

const STAGES = [
  { key: "PD", ru: "ПД", title: "Проект" },
  { key: "RD", ru: "РД", title: "Рабочая" },
  { key: "ID", ru: "ИД", title: "Исполнительная" },
] as const;

export interface StageFile {
  doc_stage: string;
}

export function StageStrip({ mentions, files, onPick }: { mentions: ProvMention[]; files: StageFile[]; onPick: (m: ProvMention) => void }) {
  return (
    <div className="stage-strip" role="list" aria-label="Стадии: проект, рабочая, исполнительная">
      {STAGES.map((s, i) => {
        const own = mentions.filter((m) => m.stage === s.key);
        const chosen = own.find((m) => m.use === "chosen") ?? null;
        const agree = own.filter((m) => m.use === "considered").length;
        const other = own.filter((m) => m.use === "reference").length;
        const dropped = own.filter((m) => m.use === "dropped" || m.use === "flagged").length;
        const docs = files.filter((f) => f.doc_stage === s.key).length;
        const state = chosen ? "value" : docs ? "absent" : "missing";
        return (
          <div key={s.key} className="stage-slot-wrap" role="listitem">
            {i > 0 && <span className="stage-arrow" aria-hidden>→</span>}
            <button className={`stage-slot ${state}`} disabled={!chosen} onClick={() => chosen && onPick(chosen)} title={chosen ? `${chosen.document_code}, стр. ${chosen.page}: «${chosen.quote}»` : undefined}>
              <span className="stage-head">
                <span className={`stagetag ${s.key}`}>{s.ru}</span>
                <span className="small mute">{s.title}</span>
              </span>
              {chosen ? (
                <>
                  <b className="num">{chosen.qualifier === "min" ? `не ниже ${chosen.value}` : chosen.value}</b>
                  <span className="small">
                    <span className="mono">{chosen.document_code}</span> · стр. {chosen.page}
                  </span>
                </>
              ) : (
                <>
                  <b className="stage-none">—</b>
                  <span className="small">{docs ? `нет в ${docs} ${plural(docs, "документе", "документах", "документах")} стадии` : "стадия не загружена"}</span>
                </>
              )}
              <span className="small mute">
                {[agree && `ещё ${agree} согласно`, other && `${other} другой комплект`, dropped && `${dropped} отсеяно`].filter(Boolean).join(" · ") || (chosen ? "единственное упоминание" : " ")}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
