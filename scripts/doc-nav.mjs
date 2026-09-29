// Shared navigation for the generated GERA documentation pages.
// Keep links relative to docs/gera/ so these pages work from local files and the site.
export const DOC_NAV_CSS = `
.doc-nav{position:sticky;top:0;z-index:30;display:flex;flex:none;align-items:center;gap:6px;min-width:0;padding:7px 14px;background:#fff;border-bottom:1px solid #D9DBE5;box-shadow:0 1px 3px rgba(23,24,43,.06)}
.doc-nav .brand{flex:none;font:700 12px/1.2 system-ui,sans-serif;color:#1D1F2E;text-decoration:none;padding:5px 8px;border-right:1px solid #D9DBE5;margin-right:2px}
.doc-nav .links{display:flex;gap:4px;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:thin;min-width:0;flex:1}
.doc-nav a{flex:none;white-space:nowrap;border:1px solid transparent;border-radius:5px;padding:6px 9px;color:#474B62;text-decoration:none;font:600 12px/1.2 system-ui,sans-serif}
.doc-nav a:hover{background:#F1F2F6;color:#1D1F2E}
.doc-nav a[aria-current=page]{background:#EAEDF8;border-color:#A9B2D8;color:#283B91}
.doc-nav a:focus-visible{outline:2px solid #3B4FA8;outline-offset:2px}
@media(max-width:700px){.doc-nav{padding:6px 8px}.doc-nav .brand{display:none}.doc-nav a{padding:7px 9px}}
`;

const LINKS = [
  ["detail", "Детальная трасса", "TRACE-MAP.html?view=detail"],
  ["map", "Карта ГЕРЫ", "TRACE-MAP.html?view=map"],
  ["doc", "Карта ТЗ", "TRACE-MAP.html?view=doc"],
  ["architecture", "Архитектура", "ARCHITECTURE.html"],
  ["pipeline", "Пайплайн", "PIPELINE.html"],
  ["coverage", "Покрытие ТЗ", "TRACE-MAP.html?view=coverage"],
  ["audit", "Контроль критиков", "TRACE-MAP.html?view=audit"],
  ["catalog", "Каталог TO-BE", "TRACE-MAP.html?view=catalog"],
  ["metrics", "Метрики", "TRACE-MAP.html?view=metrics"],
  ["gaps", "Пробелы", "TRACE-MAP.html?view=gaps"],
  ["guide", "Руководство пользователя", "../guide/index.html"],
];

export function renderDocNav(active = "", { base = "", guideHref = "../guide/index.html" } = {}) {
  return `<nav class="doc-nav" aria-label="Документация ГЕРЫ"><a class="brand" href="${base}TRACE-MAP.html?view=map">Инспектор ИИ · ГЕРА</a><div class="links">${LINKS.map(([key, title, href]) => `<a href="${key === "guide" ? guideHref : `${base}${href}`}" data-doc-view="${key}"${key === active ? ' aria-current="page"' : ""}>${title}</a>`).join("")}</div></nav>`;
}
