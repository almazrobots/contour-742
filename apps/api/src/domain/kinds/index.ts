// Список видов параметров из реестра (T-186, OS-INSP-7.1.20): одна строка на вид, по алфавиту — ветки волн не
// сталкиваются на одной строке. Модуль вида вызывает registerKind(...) из ../param-kinds.ts; из passport.ts он берёт
// только типы (import type), иначе — циклический импорт до построения схемы паспорта.
// Пример: import "./presence.ts";
import "./composition.ts";
import "./count.ts";
import "./direction.ts";
import "./doc-requirements.ts";
import "./presence.ts"; // T-212: presence (CMP-09) и method (CMP-23)
import "./schedule.ts";
import "./geometry.ts";
import "./category.ts"; // T-176: CMP-05 SUBST
import "./layers.ts"; // T-176: CMP-21 LAYER-SEQ
export {};
