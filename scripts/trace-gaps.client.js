// Gaps has its own filters; map search must not silently navigate away.
let gapScope = 'all';
let gapModelStatus = 'open';
function renderGaps() {
  const q = $('#q').value.trim().toLocaleLowerCase('ru');
  const matches = (value) => !q || JSON.stringify(value).toLocaleLowerCase('ru').includes(q);
  const open = D.atoms.filter((a) => a.color !== 'green');
  const matching = open.filter(matches);
  const shown = matching.filter((a) => gapScope === 'all' || a.color === gapScope);
  const tab = (k, title) => `<button class="btn ${gapScope === k ? 'on' : ''}" aria-pressed="${gapScope === k}" data-scope="${k}">${title} · ${matching.filter((a) => k === 'all' || a.color === k).length}</button>`;
  const refs = (items) => items.length ? items.map((x) => `<div class="mono">${esc(x)}</div>`).join('') : 'Не указаны в текущей трассе';
  let h = `<div class="gaps"><h2>Незавершённые требования</h2><button class="btn" data-model-jump>Перейти к вопросам модели и согласования</button><p>Показано ${shown.length} из ${open.length}. Это список открытых вопросов по трассе и датированному аудиту. Наличие кода или теста не означает выполнение критерия. Неизвестные результаты отмечены явно; проценты не пересчитываются по этим карточкам.</p><div class="filt">${tab('all', 'Все')}${tab('red', 'Реализация не подтверждена')}${tab('yellow', 'Неполнота или недостаток доказательств')}${tab('blue', 'Требуется приёмка в целевом контуре')}</div>`;
  if (!shown.length) h += '<p role="status">По этим фильтрам требований нет.</p>';
  for (const a of shown) {
    const e = a.gapEvidence;
    h += `<article class="gap st-${a.color}" data-gap-atom="${a.id}"><div class="id">${a.id} · ${esc(a.sectionTitle)} · ${esc(SCOPE[a.scope] ?? a.scope)}</div><h3>${esc(a.t)}</h3><p><b>Основание открытого статуса:</b> ${esc(a.why)}</p><p><b>Чего не хватает / что не подтверждено:</b> ${esc(e.missing)}</p><p><b>Оговорка требования:</b> ${esc(a.note || 'Не указана')}</p><p><b>Следующий шаг:</b> ${esc(e.next)}</p><p><b>Критерий закрытия:</b> ${esc(e.closureRequirement)}. Проверка: ${esc(e.close)}; результат должен содержать ревизию и условия проверки.</p><details><summary>Требование, реализация, тесты и результаты</summary><p>Источник: docs/tz/tz-decomposition.yaml → ${a.id}; ${esc(a.itemTitle)}.</p>${e.refs.map((r) => `<div><button class="chip" data-go="${r.id}">${r.id}</button><p><b>Код:</b></p>${refs(r.code)}<p><b>Тесты (ссылки, не результат запуска):</b></p>${refs(r.tests)}</div>`).join('') || '<p>Связей с реализацией нет.</p>'}<p><b>Историческое замечание:</b> ${e.audit ? `${esc(e.audit.at)} · ${esc(e.audit.revision)} · ${esc(e.audit.verdict)}${e.audit.uncertain ? ' · спорно' : ''}: ${esc(e.audit.evidence)}` : 'Аудит не найден'}</p><p><b>Стенд:</b> ${esc(e.stand)}</p></details></article>`;
  }
  const model = D.gaps.filter((g) => (gapModelStatus === 'all' || g.status === gapModelStatus) && matches(g));
  h += `<h2 id="model-gaps-heading">Вопросы модели и согласования</h2><p>Открыто ${D.gaps.filter((g) => g.status === 'open').length}; показано ${model.length} с учётом поиска.</p><div class="filt">${[['open','Открытые'],['closed','Закрытые'],['all','Все']].map(([key,title]) => `<button class="btn ${gapModelStatus === key ? 'on' : ''}" aria-pressed="${gapModelStatus === key}" data-model-status="${key}">${title}</button>`).join('')}</div>`;
  if (!model.length) h += '<p role="status">По этим фильтрам вопросов модели нет.</p>';
  h += model.map((g) => `<article class="gap st-${g.status === 'open' ? 'partial' : 'done'}" data-model-gap="${g.id}"><div class="id">${g.id} · ${g.status === 'open' ? 'открыт' : 'закрыт'}</div><h3>${esc(g.title)}</h3><p><b>Требование:</b> ${esc(g.review?.requirement ?? 'Сопоставление пока не выполнено')}</p><p><b>Чего не хватает:</b> ${esc(g.review?.missing ?? 'Не уточнено')}</p><p><b>Следующий шаг:</b> ${esc(g.review?.next ?? 'Перепроверить вопрос по текущим источникам')}</p><p><b>Критерий закрытия:</b> ${esc(g.review?.close ?? 'Не определён')}</p><p><b>Реализация и проверки:</b> ${esc(g.review?.evidence ?? 'Не сопоставлены')}</p><p><b>Стенд:</b> ${esc(g.review?.stand ?? 'Результат для этого вопроса не установлен')}</p></article>`).join('');
  $('#stage').innerHTML = h + '</div>';
  $('#stage .gaps').addEventListener('click', (e) => {
    if (e.target.closest('[data-model-jump]')) { $('#model-gaps-heading').scrollIntoView({block:'start'}); return; }
    const scope = e.target.closest('[data-scope]');
    if (scope) { gapScope = scope.dataset.scope; renderGaps(); return; }
    const status = e.target.closest('[data-model-status]');
    if (status) { gapModelStatus = status.dataset.modelStatus; renderGaps(); return; }
    const go = e.target.closest('[data-go]');
    if (go) {
      const node = D.nodes.find((n) => n.id === go.dataset.go || n.real === go.dataset.go);
      if (node) { setView('map'); select(node.id, {scroll: true}); }
    }
  });
}
