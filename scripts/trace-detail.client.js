// ─────────── детальная трасса (T-097): область ТЗ на странице PDF → атом → БП → БФ → БО → сервис → требование → код → тест
// Встраивается в TRACE-MAP.html генератором scripts/trace-map.mjs; использует D, byId, fwd, back, esc, $ страницы.
// статус фрагмента и атома — честный цвет (T-164, scripts/tz-color.mjs); вид фрагмента — отдельной меткой
const DV = { ...ST, candidate: "не разложено", model: "бизнес-уровень", none: "требований нет", gap: "ТЗ ≠ Матрица" };
const COLORS = ["green", "yellow", "red", "blue"];
let dtSec = D.detail?.sections[0]?.id ?? null, dtSel = null, dtPdf = true;
const BPN = D.nodes.find((n) => n.floor === "BP");
const regionsOf = (sec) => sec.regions;
const cellFile = (ref) => { const [f, s] = ref.split("::"); return { file: f.split("/").pop(), dir: f, sym: (s ?? "").replace(/^export (async )?function /, "").replace(/^def /, "").trim() }; };

// операция и выше по сервису: сервис ← операция (BO) ← функция (BF) ← процесс (BP)
function upOfService(svcId) {
  const bo = (back.get(svcId) ?? []).map((x) => byId.get(x)).find((n) => n?.floor === "BO");
  const bf = bo ? byId.get(bo.band) : null;
  return { bp: BPN, bf, bo, svc: byId.get(svcId) };
}
// одна дорожка — одна связь атома с моделью; у диалога и объекта данных дорожек столько, сколько сервисов
function lanesOf(ref) {
  const n = byId.get(ref);
  if (n && n.floor === "FS" && !n.nfr) return [{ ...upOfService(n.svc), req: { id: n.id, title: n.title, status: n.status, type: "правило" }, code: n.code, tests: n.tests }];
  if (n && n.nfr) return [{ nfr: true, req: { id: n.id, title: n.title, status: n.status, type: "НФТ · " + (MODE[n.mode] ?? n.mode) }, code: n.code, tests: n.tests }];
  const d = D.dialogIndex[ref];
  if (d) {
    const req = { id: d.id, title: d.title, status: d.status, type: "диалог" };
    if (!d.services.length) return [{ nfr: true, req, code: d.code, tests: d.tests }];
    return d.services.map((s) => ({ ...upOfService(s), req, code: d.code, tests: d.tests }));
  }
  const o = D.dataIndex[ref];
  if (o) {
    const req = { id: o.id, title: o.title, status: o.status, type: "данные" };
    // справочник (new_in пуст) не рождается в системе — дорожки по операциям, которые его читают
    const ops = o.new_in.length ? o.new_in : o.used_by;
    return ops.map((bo) => { const svc = (fwd.get(bo) ?? []).find((x) => byId.get(x)?.floor === "OS"); return svc ? { ...upOfService(svc), req, code: o.code ?? [], tests: o.tests ?? [] } : null; }).filter(Boolean);
  }
  return [{ unknown: true, req: { id: ref, title: "ссылка не найдена в модели", status: "todo", type: "?" }, code: [], tests: [] }];
}

function dtCell(col, html, cls = "", span = 1, go = null) {
  const tag = go ? "button" : "div";
  return `<${tag} class="cell c${col} ${cls}" style="grid-column:${col};grid-row:span ${span}"${go ? ` data-go="${esc(go)}"` : ""}>${html}</${tag}>`;
}
const nodeCell = (n) => `<div class="id">${n.id}</div><div class="t">${esc(n.title)}</div>`;
function codeCell(list) {
  if (!list.length) return null;
  const shown = list.slice(0, 3).map((r) => { const c = cellFile(r); return `<div class="f" title="${esc(r)}">${esc(c.file)}${c.sym ? " · " + esc(c.sym.slice(0, 48)) : ""}</div>`; }).join("");
  return `<div class="id">код · ${list.length}</div>${shown}${list.length > 3 ? `<div class="more">ещё ${list.length - 3}</div>` : ""}`;
}
function testCell(list) {
  if (!list.length) return null;
  const shown = list.slice(0, 2).map((r) => { const c = cellFile(r); return `<div class="f" title="${esc(r)}">${esc(c.sym.slice(0, 90))}</div>`; }).join("");
  return `<div class="id">тестов · ${list.length} · ${esc([...new Set(list.map((r) => cellFile(r).file))].slice(0, 2).join(", "))}</div>${shown}${list.length > 2 ? `<div class="more">ещё ${list.length - 2}</div>` : ""}`;
}
// колбаса атома: ячейка атома на все его дорожки; одинаковые БП/БФ/БО/сервис подряд сливаются в одну ячейку
function atomLanes(aid) {
  const a = D.atoms.find((x) => x.id === aid);
  if (!a) return dtCell(1, `<div class="id">${aid}</div><div class="t">атом не найден</div>`, "brk");
  let lanes = a.trace.flatMap(lanesOf);
  const atomHtml = `<div class="id"><span class="dot"></span>${a.id} · ${DV[a.color]}</div><div class="t">${esc(a.t)}</div><div class="why3">${esc(a.why)}</div>${a.note && !a.why.includes(a.note) ? `<div class="why3 nt" title="${esc(a.note)}">${esc(a.note.length > 200 ? a.note.slice(0, 200) + "…" : a.note)}</div>` : ""}<div class="id" style="margin-top:3px">${KIND[a.kind] ?? a.kind} · приёмка: ${METHOD[a.method] ?? a.method} · ${SCOPE[a.scope]}</div>`;
  if (!lanes.length) return dtCell(1, atomHtml, `atom-c st-${a.color}`) + dtCell(2, "обрыв: атом ни во что не разложен — нет правила, НФТ или диалога", "brk", 1).replace("grid-column:2", "grid-column:2 / span 7");
  let h = dtCell(1, atomHtml, `atom-c st-${a.color}`, lanes.length, null);
  const key = (l, c) => [l.nfr ? "nfr" : l.bp?.id, l.bf?.id, l.bo?.id, l.svc?.id].slice(0, c).join("|");
  lanes.forEach((l, i) => {
    const prev = lanes[i - 1];
    const spanOf = (c) => { let k = 1; while (lanes[i + k] && key(lanes[i + k], c) === key(l, c) && !lanes[i + k].nfr && !l.nfr) k++; return k; };
    const same = (c) => prev && !l.nfr && !prev.nfr && key(prev, c) === key(l, c);
    if (l.nfr || l.unknown) {
      h += dtCell(2, l.unknown ? "обрыв: ссылки нет в модели" : "сквозное ограничение — к бизнес-операции не привязано, действует на всю систему", l.unknown ? "brk" : "cross").replace("grid-column:2", "grid-column:2 / span 4");
    } else {
      if (!same(1)) h += dtCell(2, nodeCell(l.bp), "", spanOf(1), l.bp.id);
      if (!same(2)) h += l.bf ? dtCell(3, nodeCell(l.bf), "", spanOf(2), l.bf.id) : dtCell(3, "обрыв: нет функции", "brk");
      if (!same(3)) h += l.bo ? dtCell(4, nodeCell(l.bo), `st-${l.bo.status}`, spanOf(3), l.bo.id) : dtCell(4, "обрыв: нет операции", "brk");
      if (!same(4)) h += dtCell(5, nodeCell(l.svc), "os-c", spanOf(4), l.svc.id);
    }
    const r = l.req;
    h += dtCell(6, `<div class="id"><span class="dot"></span>${r.id} · ${r.type}</div><div class="t">${esc(r.title)}</div><div style="margin-top:3px"><span class="sbd">${ST[r.status] ?? r.status}</span></div>`, `${l.nfr && r.type.startsWith("НФТ") ? "nfr-c" : "req-c"} st-${r.status}`, 1, byId.has(r.id) ? r.id : null);
    const cc = codeCell(l.code), tc = testCell(l.tests);
    h += cc ? dtCell(7, cc, "code-c") : dtCell(7, r.status === "outside" ? "вне прототипа: код появится на стенде" : "обрыв: нет кода", r.status === "outside" ? "cross" : "brk");
    h += tc ? dtCell(8, tc, "test-c") : dtCell(8, cc ? "обрыв: код без теста" : "—", cc ? "brk" : "cross");
  });
  return h;
}

function dtRegion(r, n, sec, prevAtoms) {
  const st = `st-${r.status}`;
  const head = (meta) => `<div class="sgh" data-r="${r.id}"><span class="rn ${st} k-${r.kind}">${n}</span><q>${esc(r.text)}</q><div class="meta">${meta}</div></div>`;
  const kindChip = r.kind === "candidate" ? `<span class="chip kchip">не разложено</span>` : r.matrixGap ? `<span class="chip kchip">ТЗ ≠ Матрица</span>` : r.kind === "model" ? `<span class="chip">бизнес-уровень</span>` : "";
  const badge = `${kindChip}${r.gap ? `<span class="chip gapchip" title="${esc((D.gaps.find((g) => g.id === r.gap) ?? {}).title ?? "")}">${r.gap}</span>` : ""}<span class="sbd">${DV[r.status] ?? r.status}</span>`;
  const on = dtSel === r.id ? "on" : "";
  if (r.kind === "none") return `<section class="sg compact ${st} ${on}" id="dt-${r.id}">${head(`<span class="why" style="font-size:11.5px">требований нет · ${esc(r.none)}</span>`)}</section>`;
  if (r.kind === "head") {
    const at = D.atoms.filter((a) => a.item === r.head);
    const gch = r.gap ? `<span class="chip gapchip" title="${esc((D.gaps.find((g) => g.id === r.gap) ?? {}).title ?? "")}">${r.gap}</span>` : "";
    return `<section class="sg compact ${st} ${on}" id="dt-${r.id}">${head(`${gch}<span class="chip">${r.head}</span><span class="sbd">атомов ${at.length} · ${DV[r.status]}</span>`)}</section>`;
  }
  if (r.kind === "candidate") return `<section class="sg ${st} ${on}" id="dt-${r.id}">${head(badge)}<div class="why2 cand"><b>Строка ТЗ не разложена ни в один атом.</b> ${esc(r.candidate)}</div></section>`;
  if (r.kind === "model") {
    const bfs = D.nodes.filter((x) => x.floor === "BF");
    return `<section class="sg ${st} ${on}" id="dt-${r.id}">${head(badge)}<div class="why2">${esc(r.note ?? "")}</div><div class="lanes lanes-grid">${dtCell(1, `<div class="id">без атома</div><div class="t">фрагмент называет процесс целиком</div>`, "cross")}${dtCell(2, nodeCell(BPN), "", 1, BPN.id)}${dtCell(3, `<div class="id">функций · ${bfs.length}</div>${bfs.map((b) => `<div class="f" style="font-size:11px">${b.id} ${esc(b.title)}</div>`).join("")}`, "").replace("grid-column:3", "grid-column:3 / span 2")}${dtCell(5, "дальше трасса раскрывается через атомы разделов ТЗ: назначение (1.2), модули (7, 9)", "cross").replace("grid-column:5", "grid-column:5 / span 4")}</div></section>`;
  }
  // атомы
  const mx = r.matrix ? `<div class="mx">Матрица: ${Object.entries(r.matrix.per).map(([c, k]) => `<span class="p ${k ? "" : "z"}">${esc(c)} · ${k}</span>`).join("")} <span>= ${r.matrix.total} параметр${r.matrix.total % 10 === 1 && r.matrix.total !== 11 ? "" : "ов"} из 132</span></div>${r.matrixGap ? `<div class="why2 gap"><b>ТЗ требует сверять раздел, а в Матрице нет ни одного его параметра</b> — сверять нечего. Вопрос к организатору, а не к коду.</div>` : ""}` : "";
  const chips = r.atoms.map((a) => `<span class="chip">${a}</span>`).join("");
  if (prevAtoms && prevAtoms.join() === r.atoms.join()) {
    return `<section class="sg ${st} ${on}" id="dt-${r.id}">${head(chips + badge)}${mx}${r.note ? `<div class="why2">${esc(r.note)}</div>` : ""}<div class="why2">Трасса та же, что у строки выше: ${r.atoms.join(", ")}.</div></section>`;
  }
  return `<section class="sg ${st} ${on}" id="dt-${r.id}">${head(chips + badge)}${mx}${r.note ? `<div class="why2">${esc(r.note)}</div>` : ""}<div class="lanes lanes-grid">${r.atoms.map(atomLanes).join('<div class="sep"></div>')}</div></section>`;
}

const colorTiles = (by, what) => COLORS.map((c) => `<div class="m st-${c}"><b>${by[c]}</b>${DV[c]}</div>`).join("") + `<div class="m st-grey"><b>${what}</b></div>`;
const countBy = (list, key) => Object.fromEntries(COLORS.map((c) => [c, list.filter((x) => x[key] === c).length]));
function dtSummary(sec) {
  const R = sec.regions;
  const atomIds = [...new Set(R.flatMap((r) => r.atoms))];
  const at = atomIds.map((id) => D.atoms.find((a) => a.id === id)).filter(Boolean);
  const req = R.filter((r) => r.status !== "grey");
  return `<div class="dt-sum">${colorTiles(countBy(req, "status"), `фрагментов с требованиями ${req.length} из ${R.length}`)}</div><div class="dt-sum">${colorTiles(countBy(at, "color"), `атомов раздела ${at.length}`)}</div>`;
}

// весь ТЗ одним потоком: области пронумерованы сквозь документ, страница рисуется один раз
const DT = (() => {
  if (!D.detail) return null;
  const regs = [], pages = new Map();
  for (const s of D.detail.sections) {
    s.regions.forEach((r) => regs.push({ r, sec: s }));
    for (const p of s.pages) {
      const had = pages.get(p.page);
      pages.set(p.page, had ? { ...had, lines: had.lines.map((l, i) => ({ ...l, in: l.in || p.lines[i].in })) } : p);
    }
  }
  return { regs, pages: [...pages.values()].sort((a, b) => a.page - b.page), num: new Map(regs.map((x, i) => [x.r.id, i + 1])), secOf: new Map(regs.map((x) => [x.r.id, x.sec])) };
})();

function dtPage(p) {
  let h = `<div class="pg" style="--pw:${p.w};--ph:${p.h}" data-page="${p.page}"><span class="pno">стр. PDF ${p.page}${p.printed ? " · печатная " + p.printed : ""}</span>`;
  // Шрифт — из высоты строки, но строка с формулой (Σ, дробь) в PDF бывает втрое выше обычной (стр. 32, §14.3):
  // такую строку ограничиваем медианой страницы, иначе слова рисуются огромными и наезжают на соседние ячейки.
  const hs = p.lines.map((l) => l.y1 - l.y0).sort((a, b) => a - b), med = hs[hs.length >> 1] || 12;
  for (const l of p.lines) {
    const txt = l.w.map((w) => w[2]).join(" ");
    // раздутая строка: верх у неё верный (шаг строк обычный), высота — от формулы; ставим как обычную строку от верха
    const tall = l.y1 - l.y0 > 1.8 * med, lh = tall ? med : l.y1 - l.y0, f = lh / 1.23;
    const isH = /^\d{1,2}(\.\d{1,2})*\.\s+\S/.test(txt) && Math.abs(l.x0 - 70.9) < 2 && txt.length < 95;
    const cls = (p.page === 2 && l.y0 < 115) || (isH && /^\d{1,2}\.\s/.test(txt)) ? "h1" : isH ? "h2" : Math.abs(l.x0 - 42.5) > 2 && Math.abs(l.x0 - 70.9) > 2 ? "tb" : "";
    for (const [x0, x1, t] of l.w) h += `<span class="w ${cls} ${l.in ? "" : "out"}" style="--x:${x0};--y:${(l.y0 + (lh - f) * 0.45).toFixed(1)};--f:${f.toFixed(2)}" data-tw="${(x1 - x0).toFixed(1)}">${esc(t)}</span>`;
  }
  const here = DT.regs.filter((x) => x.r.page === p.page).map((x) => x.r);
  if (!p.lines.length) {
    const cov = here.find((r) => r.whole);
    h += `<div class="cover">${esc(cov?.text ?? "Страница без текстового слоя").split("\n").map((t, i) => `<div class="cv${i}">${t}</div>`).join("")}<div class="cvnote">изображение без текстового слоя · текст перенесён вручную</div></div>`;
  }
  const markRows = new Map();
  for (const r of here) {
    const cls = `st-${r.status} k-${r.kind} ${r.band ? "band" : ""} ${dtSel === r.id ? "on" : ""}`;
    for (const [x0, y0, x1, y1] of r.rects) h += `<div class="rg ${cls}" data-r="${r.id}" title="${esc(DV[r.status] ?? "")}" style="left:calc(${x0 - 1.5} * var(--s) * 1px);top:calc(${y0 - 1} * var(--s) * 1px);width:calc(${x1 - x0 + 3} * var(--s) * 1px);height:calc(${y1 - y0 + 1} * var(--s) * 1px)"></div>`;
    const y0 = r.rects[0][1];
    const row = Math.round(y0 / 4);
    const k = markRows.get(row) ?? 0; markRows.set(row, k + 1);
    h += `<span class="rn ${cls}" data-r="${r.id}" style="left:calc(${2 + k * 25}px);top:calc(${y0} * var(--s) * 1px)">${DT.num.get(r.id)}</span>`;
  }
  return h + "</div>";
}

function dtDocSummary() {
  const S = D.detail.sections, R = S.flatMap((s) => s.regions);
  const words = S.reduce((a, s) => a + s.words, 0), unc = S.reduce((a, s) => a + s.uncovered, 0);
  const atoms = new Set(R.flatMap((r) => r.atoms));
  const req = R.filter((r) => r.status !== "grey"), by = countBy(req, "status"), ab = countBy(D.atoms, "color");
  return `<div class="docline"><b>Весь ТЗ:</b> ${DT.pages.length} стр. · ${S.length} разделов · слов размечено <b>${words - unc}</b> из ${words} · областей ${R.length}, из них с требованиями ${req.length}: ${COLORS.map((c) => `<b class="c-${c}">${by[c]}</b> ${DV[c]}`).join(" · ")} · не разложено <b class="bad">${R.filter((r) => r.kind === "candidate").length}</b> · ТЗ ≠ Матрица <b class="bad">${R.filter((r) => r.matrixGap).length}</b></div>
<div class="docline"><b>Атомы ТЗ:</b> ${D.atoms.length} (задействовано ${atoms.size}): ${COLORS.map((c) => `<b class="c-${c}">${ab[c]}</b> ${DV[c]}`).join(" · ")} · сверх ТЗ <b>${D.counts.extra}</b> узлов модели</div>`;
}
const tocHtml = (cur) => `<div class="toc">${D.detail.sections.map((s) => {
  const n = s.regions.length || 1, c = (k) => s.regions.filter(k).length;
  const req = s.regions.filter((r) => r.status !== "grey"), k = req.length || 1, by = countBy(req, "status");
  const tip = COLORS.map((cl) => `${DV[cl]} ${by[cl]}`).join(", ");
  void n; void c;
  return `<button class="tc ${s.id === cur ? "on" : ""} ${s.uncovered ? "raw" : ""}" data-sec="${s.id}" title="${esc(s.title)} · фрагментов с требованиями ${req.length}: ${tip}"><b>${s.id === "S0" ? "обл." : s.id.slice(1)}</b><i>${COLORS.map((cl) => `<u style="width:${(100 * by[cl]) / k}%;background:var(--c-${cl})"></u>`).join("")}</i></button>`;
}).join("")}</div>`;

// сверх ТЗ: узлы модели, до которых не доходит ни один атом ТЗ — дополнительные функции или неподвязанная трасса (T-164)
function dtExtra() {
  const X = D.extra; if (!X) return "";
  const bySvc = new Map();
  for (const r of X.rules) (bySvc.get(r.svc) ?? bySvc.set(r.svc, []).get(r.svc)).push(r);
  const row = (x) => `<div class="xr st-${x.status === "done" ? "green" : x.status === "todo" ? "red" : "yellow"}"><button class="mono" data-go="${esc(x.id)}">${esc(x.id)}</button><span>${esc(x.t)}</span></div>`;
  const grp = (title, list) => (list.length ? `<details class="xg"><summary>${title} · ${list.length}</summary>${list.map(row).join("")}</details>` : "");
  return `<div class="sechead" id="sec-extra"><div class="shrow"><h3>Сверх ТЗ · ${D.counts.extra} узлов модели</h3><span class="sp">ни один атом ТЗ на них не ссылается</span></div>
<div class="why2">Правила, НФТ, диалоги и данные модели, которых нет в трассе ни одного атома ТЗ. Это либо функции сверх ТЗ, либо реализация требования ТЗ, не подвязанная к атому (этап 2 плана T-164). Цвет — статус узла: код и тест / код без теста / нет кода.</div>
${[...bySvc].map(([svc, list]) => grp(`${esc(svc)} ${esc(byId.get(svc)?.title ?? "")}`, list)).join("")}${grp("НФТ", X.nfr)}${grp("Диалоги", X.dialogs)}${grp("Данные", X.data)}</div>`;
}

function renderDetail() {
  if (!D.detail) { $("#stage").innerHTML = '<div class="gaps"><div class="empty">Нет data/seed/tz-layout.json или docs/tz/regions/ — вкладка не собрана.</div></div>'; return; }
  const S = D.detail.sections;
  dtSec = S.some((s) => s.id === dtSec) ? dtSec : S[0].id;
  const right = S.map((sec) => {
    let prevAtoms = null;
    const blocks = sec.regions.map((r) => { const out = dtRegion(r, DT.num.get(r.id), sec, prevAtoms); if (r.kind === "atoms") prevAtoms = r.atoms; else if (r.kind !== "none" && r.kind !== "head") prevAtoms = null; return out; }).join("");
    const pages = [...new Set(sec.pages.map((p) => p.page))];
    return `<div class="sechead" id="sec-${sec.id}"><div class="shrow"><h3>${esc(sec.title)}</h3><span class="sp">стр. PDF ${pages[0]}${pages.length > 1 ? "–" + pages.at(-1) : ""} · областей ${sec.regions.length}</span></div>${dtSummary(sec)}${sec.matrixExtra.length ? `<div class="why2 gap" style="margin:6px 0 0">В Матрице есть разделы, которых нет в таблице раздела 3 ТЗ: ${sec.matrixExtra.map((x) => `<b>${esc(x.code)}</b> (${x.n})`).join(", ")} — расхождение ТЗ и Матрицы.</div>` : ""}</div>${blocks}`;
  }).join("");
  const cols = ["Атом ТЗ", "1 · БП", "2 · БФ", "3 · БО", "RS · Сервис", "RS · Требование", "5 · Код", "7 · Тест"].map((t, i) => `<div class="${i === 4 || i === 5 ? "sys" : ""}">${t}</div>`).join("");
  const cur = S.find((s) => s.id === dtSec);
  $("#stage").innerHTML = `<div class="dt ${dtPdf ? "" : "nopdf"}">
<div class="dt-left" id="dtl"><div class="dt-bar"><div id="dttoc">${tocHtml(dtSec)}</div><div class="secnav"><b id="dtcur">${esc(cur.title)}</b><span class="sp">клик по фрагменту — справа его цепочка</span></div></div>${DT.pages.map(dtPage).join("")}<div style="height:50vh"></div></div>
<div class="dt-right" id="dtr">
<div class="dt-head"><div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap"><h2>Детальная трасса · весь ТЗ</h2><button class="btn" id="dtpdf">${dtPdf ? "Скрыть PDF" : "Показать PDF"}</button></div>
<div class="dsub">Весь документ одним потоком: слева страницы ТЗ, справа — каждый фрагмент, разложенный вниз до кода: <b>атом</b> → <b>бизнес-процесс → функция → операция</b> → <b>сервис</b> и его <b>требование</b> → <b>код</b> → <b>тест</b>. Стороны прокручиваются независимо: клик по фрагменту в PDF показывает справа его цепочку, клик по цепочке — её место в PDF. Лента разделов показывает, где вы в PDF. Красный пунктир — обрыв цепочки.</div>
${dtDocSummary()}
<div class="dt-legend">${COLORS.map((k) => `<span class="st-${k}"><i></i>${DV[k]}</span>`).join("")}<span class="st-grey"><i></i>требований нет</span><span class="why3" style="margin:0">зелёный — код делает требуемое и тест проверяет критерий приёмки (вердикт критиков); красный — кода нет, фрагмент не разложен или ТЗ ≠ Матрица</span></div></div>
<div class="dt-cols"><div class="lanes-grid">${cols}</div></div>
${right}${dtExtra()}<div style="height:60vh"></div></div></div>`;
  fitWords();
  const L = $("#dtl"), R = $("#dtr");
  L.addEventListener("scroll", () => onDtScroll("left"), { passive: true });
  R.addEventListener("scroll", () => onDtScroll("right"), { passive: true });
  requestAnimationFrame(() => { buildAnchors(); jumpToSection(dtSec, false); });
}
// слово занимает ровно свою ширину из PDF: шрифт другой, поэтому слово растягивается или сжимается по горизонтали
function fitWords() {
  const L = $("#dtl"); if (!L || !dtPdf) return;
  const s = Math.min(1.3, (L.clientWidth - 36) / 595.3);
  L.style.setProperty("--s", s.toFixed(4));
  const ws = [...L.querySelectorAll(".w")];
  ws.forEach((w) => (w.style.transform = ""));
  const nat = ws.map((w) => w.getBoundingClientRect().width);
  ws.forEach((w, i) => { const k = (Number(w.dataset.tw) * s) / (nat[i] || 1); if (k > 0.5 && k < 2) w.style.transform = `scaleX(${k.toFixed(3)})`; });
}

// ─────────── связь сторон — только по клику: каждая сторона прокручивается сама; опорная точка — область слева и её блок справа
let dtAnchors = [], dtRaf = 0;
const REF_L = 0.3, REF_R = 70; // по клику область встаёт на 30 % высоты PDF, её блок справа — под шапку колонок
function buildAnchors() {
  const L = $("#dtl"), R = $("#dtr"); if (!L || !R) return;
  const lt = L.getBoundingClientRect().top - L.scrollTop, rt = R.getBoundingClientRect().top - R.scrollTop;
  const lpos = new Map();
  L.querySelectorAll(".rg").forEach((e) => { if (!lpos.has(e.dataset.r)) lpos.set(e.dataset.r, e.getBoundingClientRect().top - lt); });
  const out = [];
  for (const { r } of DT.regs) {
    const re = document.getElementById("dt-" + r.id);
    const a = { id: r.id, L: dtPdf ? lpos.get(r.id) ?? null : 0, R: re ? re.getBoundingClientRect().top - rt : null };
    if (a.R == null || (dtPdf && a.L == null)) continue;
    if (!out.length || !dtPdf || (a.L >= out.at(-1).L && a.R > out.at(-1).R)) out.push(a);
  }
  dtAnchors = out;
}
function anchorAt(pos, side) { const A = dtAnchors; let i = 0; while (i < A.length - 1 && A[i + 1][side] <= pos) i++; return A[i]; }
// лента разделов следит за PDF (без PDF — за правой стороной); вторую сторону прокрутка не двигает
function onDtScroll(side) {
  if (view !== "detail" || (dtPdf ? side !== "left" : side !== "right")) return;
  cancelAnimationFrame(dtRaf);
  dtRaf = requestAnimationFrame(() => {
    const L = $("#dtl"), R = $("#dtr"); if (!L || !R || !dtAnchors.length) return;
    const a = dtPdf ? anchorAt(L.scrollTop + REF_L * L.clientHeight + 2, "L") : anchorAt(R.scrollTop + REF_R + 2, "R");
    const sec = a && DT.secOf.get(a.id);
    if (sec && sec.id !== dtSec) {
      dtSec = sec.id;
      document.querySelectorAll("#dttoc .tc").forEach((b) => b.classList.toggle("on", b.dataset.sec === dtSec));
      $("#dtcur").textContent = sec.title;
    }
  });
}
// координаты для прокрутки по клику берутся живыми: высоты блоков меняются после загрузки шрифтов и подгонки слов
const topIn = (box, el) => el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
function jumpToSection(id, smooth = true) {
  const L = $("#dtl"), R = $("#dtr"), beh = smooth ? "smooth" : "auto";
  const sec = D.detail.sections.find((s) => s.id === id); if (!sec) return;
  const first = sec.regions[0] && L.querySelector(`.rg[data-r="${CSS.escape(sec.regions[0].id)}"], .rn[data-r="${CSS.escape(sec.regions[0].id)}"]`);
  if (dtPdf && first) L.scrollTo({ top: Math.max(0, topIn(L, first) - REF_L * L.clientHeight + 2), behavior: beh });
  const head = document.getElementById("sec-" + id);
  if (head) R.scrollTo({ top: topIn(R, head) - 40, behavior: beh });
}
// клик по области слева прокручивает правую сторону к её цепочке; клик по цепочке справа — PDF к её области
function dtPick(id, from) {
  dtSel = id;
  document.querySelectorAll("#stage [data-r]").forEach((e) => e.classList.toggle("on", e.dataset.r === id));
  document.querySelectorAll("#stage .sg").forEach((e) => e.classList.toggle("on", e.id === "dt-" + id));
  const L = $("#dtl"), R = $("#dtr");
  if (from === "left") { const el = document.getElementById("dt-" + id); if (el) R.scrollTo({ top: topIn(R, el) - REF_R, behavior: "smooth" }); }
  else if (dtPdf) { const el = L.querySelector(`.rg[data-r="${CSS.escape(id)}"]`); if (el) L.scrollTo({ top: Math.max(0, topIn(L, el) - REF_L * L.clientHeight), behavior: "smooth" }); }
}
$("#stage").addEventListener("click", (e) => {
  if (view !== "detail") return;
  const sb = e.target.closest("[data-sec]"); if (sb) { jumpToSection(sb.dataset.sec); return; }
  if (e.target.closest("#dtpdf")) { dtPdf = !dtPdf; renderDetail(); return; }
  const g = e.target.closest("[data-go]"); if (g && byId.has(g.dataset.go)) { setView("map"); select(g.dataset.go, { scroll: true }); return; }
  const r = e.target.closest("[data-r]"); if (r) return dtPick(r.dataset.r, r.closest("#dtl") ? "left" : "right");
  const sg = e.target.closest("#dtr .sg"); if (sg) dtPick(sg.id.slice(3), "right");
});
$("#stage").addEventListener("mouseover", (e) => {
  if (view !== "detail") return;
  const r = e.target.closest("[data-r]"); const id = r?.dataset.r ?? null;
  document.querySelectorAll("#stage .rg, #stage .sg").forEach((x) => x.classList.toggle("hov", !!id && (x.dataset.r === id || x.id === "dt-" + id)));
});
let dtRs; addEventListener("resize", () => { if (view !== "detail") return; clearTimeout(dtRs); dtRs = setTimeout(() => { fitWords(); buildAnchors(); }, 150); });
document.fonts?.ready.then(() => { if (view === "detail") { fitWords(); buildAnchors(); } });
