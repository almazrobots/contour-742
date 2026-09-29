// Окно отмены (T-111, переход T8 карты сценариев): необратимое действие уходит на сервер не сразу, а через 10 с.
// Пока окно открыто, «Отменить» или клавиша Z возвращают всё как было — вместо модального «Вы уверены?».
import { useEffect, useRef, useState } from "react";

export const UNDO_MS = 10_000;

export function UndoWindow({ text, onCommit, onCancel, ms = UNDO_MS }: { text: string; onCommit: () => void; onCancel: () => void; ms?: number }) {
  const [left, setLeft] = useState(ms);
  const done = useRef(false);
  useEffect(() => {
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const rest = Math.max(ms - (performance.now() - start), 0);
      setLeft(rest);
      if (rest === 0) {
        if (!done.current) {
          done.current = true;
          onCommit();
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onKey = (e: KeyboardEvent) => {
      if ((e.code === "KeyZ" || e.code === "Escape") && !done.current) {
        e.preventDefault();
        done.current = true;
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
    };
    // окно одно на действие: перезапуск только при новом монтировании
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="undo-window" role="status" aria-live="polite">
      <div className="undo-row">
        <span>
          {text} через <b className="num">{Math.ceil(left / 1000)}</b> с
        </span>
        <button
          className="btn undo-btn"
          onClick={() => {
            if (done.current) return;
            done.current = true;
            onCancel();
          }}
        >
          Отменить <span className="kbd">Z</span>
        </button>
      </div>
      <div className="undo-track">
        <div className="undo-fill" style={{ transform: `scaleX(${left / ms})` }} />
      </div>
    </div>
  );
}
