import { useEffect, useState } from "react";
import { provenanceLine, publication, type Publication } from "../lib/demo";

/** Плашка демо-стенда: только просмотр, откуда данные, ссылки на карту требований и методику (T-131). */
export function DemoBanner() {
  const [p, setP] = useState<Publication | null>(null);
  useEffect(() => {
    void publication().then((x) => {
      setP(x);
      // признак для стилей: в режиме только просмотра кнопки изменений ([data-mutates]) скрыты — API всё равно ответит 403
      if (x) document.documentElement.dataset.readonly = "1";
    });
  }, []);
  if (!p) return null;
  return (
    <div className="demo-banner" role="note" aria-label="Демо-стенд только для просмотра">
      <b>Демо-стенд «Надзориум» · только просмотр</b>
      <span>{provenanceLine(p)}</span>
      <nav>
        <a href="/docs/gera/TRACE-MAP.html">Карта требований</a>
        <a href="/docs/gera/PIPELINE.html">Пайплайн</a>
        <a href="/docs/gera/ARCHITECTURE.html">Архитектура</a>
        <a href="/docs/index.html">Все материалы</a>
      </nav>
    </div>
  );
}
