// Все упоминания параметра по стадиям — класса (OS-INSP-4.1.18, T-130) и количества (OS-INSP-4.1.22, T-132): что взято значением стадии, что учтено, что
// отсеяно и почему; как найден текст (текстовый слой, скан, модель-читатель), что прочитали Tesseract и модели, что
// сказала проверка фрагмента листа. Щелчок по строке — это место на листе. Слова — инспектора, без кодов и жаргона.
import { STAGE_RU } from "../lib/labels";
import { byUse, judgeText, modelLabel, OUTCOME, SOURCE } from "../lib/mentions";

export interface ProvMention {
  stage: string;
  use: "chosen" | "considered" | "reference" | "dropped" | "flagged";
  why: string | null;
  value: string;
  qualifier: "min" | null;
  discipline: string | null;
  document_code: string;
  file_id: string;
  page: number;
  quote: string;
  bbox?: [number, number, number, number] | null;
  anchor_bbox?: [number, number, number, number] | null; // подпись показателя (T-132)
  excluded?: string | null;
  source?: string | null;
  readings?: Array<{ by: string; value: string | null }> | null;
  reader_outcome?: string | null;
  judge?: { outcome: string; value: string | null; subject: string | null; note: string } | null;
}

const USE: Record<ProvMention["use"], { ru: string; tone: string }> = {
  chosen: { ru: "значение стадии", tone: "violet" },
  considered: { ru: "учтено", tone: "gray" },
  reference: { ru: "справочно: другой комплект", tone: "gray" },
  dropped: { ru: "отсеяно", tone: "gray" },
  flagged: { ru: "под сомнением", tone: "amber" },
};

const show = (m: ProvMention) => (m.qualifier === "min" ? `не ниже ${m.value}` : m.value);
const keyOf = (m: ProvMention) => `${m.file_id}@${m.page}:${m.value}:${m.quote.slice(0, 40)}`;

export function ClassMentions({ mentions, picked, onPick }: { mentions: ProvMention[]; picked: string | null; onPick: (m: ProvMention | null) => void }) {
  const stages = [...new Set(mentions.map((m) => m.stage))];
  return (
    <div className="stack mentions" style={{ gap: 8 }} aria-label="Все упоминания параметра">
      <div className="row">
        <span className="label">Все упоминания ({mentions.length})</span>
        <span style={{ flex: 1 }} />
        {picked && (
          <button className="btn ghost small" onClick={() => onPick(null)}>
            Убрать с листа
          </button>
        )}
      </div>
      {stages.map((s) => (
        <div key={s} className="stack" style={{ gap: 4 }}>
          <span className="small mute">{STAGE_RU[s] ?? s}</span>
          {byUse(mentions.filter((m) => m.stage === s)).map((m) => {
              const k = keyOf(m);
              const u = USE[m.use] ?? USE.considered;
              const off = m.use === "dropped" || m.use === "reference";
              return (
                <button key={k} className={`src mention ${picked === k ? "on" : ""} ${off ? "off" : ""}`} onClick={() => onPick(picked === k ? null : m)} title={m.quote}>
                  <span className={`stagetag ${m.stage}`}>{STAGE_RU[m.stage] ?? m.stage}</span>
                  <span className="stack" style={{ gap: 2, minWidth: 0 }}>
                    <span>
                      <span className="mono small" style={{ fontWeight: 600 }}>{m.document_code}</span> <span className="small mute">· стр. {m.page}</span>{" "}
                      <span className={`pill ${u.tone}`}>{u.ru}</span>
                    </span>
                    <span className="small mute">
                      {SOURCE[m.source ?? ""] ?? "источник текста не указан"}
                      {m.reader_outcome ? ` · ${OUTCOME[m.reader_outcome] ?? m.reader_outcome}` : ""}
                    </span>
                    {m.readings && m.readings.length > 0 && (
                      <span className="small readings">
                        {m.readings.map((r, i) => (
                          <span key={i} className="reading">
                            {modelLabel(r.by)}: <b>{r.value ?? "—"}</b>
                          </span>
                        ))}
                      </span>
                    )}
                    {m.judge && <span className="small">Проверка фрагмента листа: {judgeText(m.judge)}</span>}
                    {/* цитата — откуда число: строка ТЭП или объединённая ячейка ведомости (T-132); у отсеянных — причина */}
                    {m.use !== "dropped" && m.quote && <span className="small quote">«{m.quote.length > 160 ? `${m.quote.slice(0, 157)}…` : m.quote}»</span>}
                    {m.why && <span className="small mute">{m.why}</span>}
                  </span>
                  <span className="num" style={{ fontWeight: 650 }}>{show(m)}</span>
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
}

export const mentionKey = keyOf;
