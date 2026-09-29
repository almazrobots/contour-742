// Inventory of dated verdicts. No product tests or semantic re-audit are implied.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse } from 'yaml';

const AUDIT = 'docs/trace/COVERAGE-AUDIT.json';
const MODEL = 'docs/gera/inspector/model.yaml';
const TZ = 'docs/tz/tz-decomposition.yaml';
// Historical links are opt-in: clean handoffs do not contain development history.
const WEB = process.env.AUDIT_HISTORY_REPOSITORY_URL || null;
const encodePath = p => p.split('/').map(encodeURIComponent).join('/');
const blobLink = (rev, path) => WEB ? `${WEB}/blob/${rev}/${encodePath(path)}` : null;
const signature = a => JSON.stringify([a?.t, a?.accept, [...(a?.trace ?? [])].sort(), a?.scope ?? 'prototype', !!a?.partial, a?.note ?? '']);
const atomsOf = dz => dz.sections.flatMap(s => s.items.flatMap(i => i.atoms));
const nodeOf = (model, ref) => model.impl?.[ref] ?? [...(model.dialogs ?? []), ...(model.data ?? [])].find(n => n.id === ref) ?? null;
const refsOf = (model, atom) => (atom?.trace ?? []).flatMap(ref => {
  const n = nodeOf(model, ref);
  return [...(n?.code ?? []), ...(n?.tests ?? [])].map(x => x.split('::')[0]);
});

export function buildProvenance(root, audit, snapshots, model, dz) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
  const head = git('rev-parse', 'HEAD').trim();
  const cache = new Map();
  function revision(rev) {
    // Mutable branch names must never become a purported historical revision.
    if (!/^[0-9a-f]{7,40}$/.test(rev ?? '')) return null;
    if (cache.has(rev)) return cache.get(rev);
    let value = null;
    try {
      const sha = git('rev-parse', '--verify', `${rev}^{commit}`).trim();
      const tree = new Map(git('ls-tree', '-rz', sha).split('\0').filter(Boolean).map(x => {
        const [meta, path] = x.split('\t'); return [path, meta.split(' ')[2]];
      }));
      value = { sha, tree, model: parse(git('show', `${sha}:${MODEL}`)), atoms: new Map(atomsOf(parse(git('show', `${sha}:${TZ}`))).map(a => [a.id, a])) };
    } catch { /* missing history is unknown, never fresh */ }
    cache.set(rev, value); return value;
  }
  const headTree = revision(head)?.tree ?? new Map();
  const currentFiles = git('ls-files', '-z').split('\0').filter(Boolean);
  const hashes = new Map();
  function currentHash(path) {
    if (!hashes.has(path)) {
      try { const b = readFileSync(join(root, path)); hashes.set(path, createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')); }
      catch { hashes.set(path, null); }
    }
    return hashes.get(path);
  }
  const auditText = readFileSync(join(root, AUDIT), 'utf8').split('\n');
  const records = atomsOf(dz).map(a => {
    const v = audit.atoms[a.id];
    const batchReview = [...(audit.reaudits ?? [])].reverse().find(r => r.atoms?.includes(a.id));
    const individual = v?.reaudited;
    const review = batchReview && (!individual || batchReview.at > individual.at) ? batchReview : individual ?? batchReview ?? { at: audit.audited_at, revision: audit.revision };
    const old = revision(review.revision);
    const oldAtom = old?.atoms.get(a.id);
    const snap = snapshots?.atoms?.[a.id];
    const reasons = [], unknown = [];
    if (!v) unknown.push('нет вердикта');
    if (!review.at) unknown.push('неизвестна дата');
    if (!old) unknown.push('ревизия неизвестна или недоступна');
    if (old && !oldAtom) unknown.push('атом отсутствует на ревизии проверки');
    if (oldAtom && signature(a) !== signature(oldAtom)) reasons.push('изменены требование, критерий, трасса или условия реализации');
    if (!snap) unknown.push('нет индивидуального снимка');
    else if (JSON.stringify([a.t, a.accept, [...(a.trace ?? [])].sort()]) !== JSON.stringify([snap.t, snap.accept, [...(snap.trace ?? [])].sort()])) reasons.push('отличие от снимка аудитора');
    if (oldAtom && (a.trace ?? []).some(ref => JSON.stringify(nodeOf(model, ref)) !== JSON.stringify(nodeOf(old.model, ref)))) reasons.push('изменены связи модели с кодом/тестами');
    const paths = new Set([...refsOf(model, a), ...(oldAtom ? refsOf(old.model, oldAtom) : [])]);
    // Evidence often uses abbreviated filenames. Ambiguous matches remain explicitly unknown.
    const candidates = new Set([...currentFiles, ...(old?.tree.keys() ?? [])]);
    const mentions = [...(v?.evidence ?? '').matchAll(/(?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|m?js|py|ya?ml|json|sql|sh|md|html|conf|toml|txt|csv)\b/g)].map(m => m[0]);
    for (const mention of mentions) {
      const matches = candidates.has(mention) ? [mention] : [...candidates].filter(p => p.endsWith('/' + mention));
      if (matches.length === 1) paths.add(matches[0]);
      else unknown.push(`${matches.length ? 'неоднозначная' : 'не найдена'} ссылка: ${mention}`);
    }
    if (!paths.size) unknown.push('нет файлов доказательства');
    const files = [...paths].sort().map(path => {
      const before = old?.tree.get(path) ?? null, now = currentHash(path);
      const state = !old ? 'unknown' : !before ? 'not_at_review' : !now ? 'missing' : before !== now ? 'changed' : 'unchanged';
      return { path, reviewed_blob: before, current_blob: now, state, reviewed_url: before ? blobLink(old.sha, path) : null, current_url: now && headTree.get(path) === now ? blobLink(head, path) : null };
    });
    if (files.some(f => ['changed', 'missing', 'not_at_review'].includes(f.state))) reasons.push('файлы кода/тестов/оснований изменены после проверки');
    const status = reasons.length ? 'reaudit_required' : unknown.length ? 'unknown' : 'unchanged_not_reaudited';
    const line = auditText.findIndex(l => l.includes(`"${a.id}":`)) + 1;
    return { id: a.id, requirement: a.t, verdict: v?.verdict ?? 'UNKNOWN', uncertain: v?.uncertain ?? true,
      reviewed_at: review.at ?? null, declared_revision: review.revision ?? null, reviewed_revision: old?.sha ?? null,
      metadata_source: review === individual ? 'atom.reaudited' : review.atoms ? 'reaudits' : 'base audit',
      review_history: [{ at: audit.audited_at, revision: audit.revision }, ...(audit.reaudits ?? []).filter(r => r.atoms?.includes(a.id)).map(({ at, revision, note }) => ({ at, revision, note })), ...(individual ? [individual] : [])],
      evidence: v?.evidence ?? null, source_url: WEB && headTree.get(AUDIT) === currentHash(AUDIT) ? blobLink(head, AUDIT) + (line ? `#L${line}` : '') : null,
      snapshot_revision: snap?.reviewed_revision ?? snapshots?.revision ?? null,
      status, reasons, unknown, files,
      review_url: old ? blobLink(old.sha, TZ) : null };
  });
  return { schema: 1, checked_revision: head, method: 'Сравнение полных файлов и связей с ревизией вердикта. Изменение файла консервативно требует повторного аудита; неизменность не доказывает актуальную приёмку. Транзитивные зависимости, окружение и работа продукта не проверены.',
    totals: { atoms: records.length, real: records.filter(r => r.verdict === 'REAL').length, uncertain: records.filter(r => r.uncertain).length,
      ...Object.fromEntries(['reaudit_required', 'unknown', 'unchanged_not_reaudited'].map(s => [s, records.filter(r => r.status === s).length])) },
    records, defects: (audit.defects ?? []).map(d => ({ ...d, provenance_id: d.id, status_scope: 'исторический статус из реестра; повторное воспроизведение и закрытие не подтверждены' })) };
}

const esc = s => String(s ?? 'неизвестно').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
export function renderProvenance(registry) {
  const names = { reaudit_required: 'Требует повторного аудита', unknown: 'Актуальность неизвестна', unchanged_not_reaudited: 'Изменений в проверенных файлах не найдено; нового аудита нет' };
  const link = (url, title) => url ? `<a href="${esc(url)}">${esc(title)}</a>` : esc(title);
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Реестр оснований аудита</title><style>body{font:16px/1.5 system-ui;max-width:1100px;margin:24px auto;padding:0 16px;overflow-wrap:anywhere}a{color:#1265ae}article{border-top:1px solid #aaa;padding:16px 0;overflow-wrap:anywhere}small{display:block}input{padding:10px;width:90%}li{margin:8px 0}pre{white-space:pre-wrap}</style><a href="../gera/TRACE-MAP.html?view=audit">← Контроль критиков</a><h1>Реестр оснований аудита</h1>
<p>Инвентаризация на ${esc(registry.checked_revision)}. ${esc(registry.method)}</p><p>Даты ниже — даты исходных проверок, а не этой инвентаризации. <a href="AUDIT-PROVENANCE.json">Машиночитаемый реестр</a>.</p>
<p>Всего ${registry.totals.atoms} вердиктов; исторических REAL — ${registry.totals.real}; спорных — ${registry.totals.uncertain}. Требуют повторного аудита — ${registry.totals.reaudit_required}; актуальность неизвестна — ${registry.totals.unknown}; изменений в проверенных файлах не найдено — ${registry.totals.unchanged_not_reaudited}.</p>
<h2>Происхождение 94 REAL и 63 зелёных</h2><p>Это сохранённый срез 29.09.2026: ${link(blobLink('83656fdd', 'docs/trace/TZ-COVERAGE.json'), 'TZ-COVERAGE.json на 83656fdd')}. 94 — количество REAL в смешанном реестре. 63 — результат старой формулы цвета, которая учитывала снимок текста/трассы, но не изменение файлов кода и тестов. Эти числа не являются свежей приёмкой текущего кода. Исторические вердикты сохранены без повышения процентов.</p>
<h2>Открытые дефекты исходного аудита</h2><ul>${registry.defects.map(d => `<li><a href="#${esc(d.id)}">${esc(d.id)}</a>: ${esc(d.t)} — ${esc(d.status)}, ${esc(d.task)}. ${esc(d.status_scope)}</li>`).join('')}</ul>
<h2>Все вердикты, включая спорные</h2><label>Поиск по ID, вердикту, доказательству или статусу <input id="filter" type="search"></label><p id="count"></p>${registry.records.map(r => `<article id="${esc(r.id)}"><h3>${esc(r.id)} · ${esc(r.verdict)}${r.uncertain ? ' · спорно' : ''}</h3><p>${esc(r.requirement)}</p><b>${esc(names[r.status])}</b><small>Дата проверки: ${esc(r.reviewed_at)}; ревизия: ${esc(r.reviewed_revision ?? r.declared_revision)}; источник метаданных: ${esc(r.metadata_source)}.</small><p>${link(r.source_url, 'Запись вердикта')} · ${link(r.review_url, 'Требования на ревизии проверки')}</p><p>${esc(r.evidence)}</p><ul>${[...r.reasons, ...r.unknown].map(x => `<li>${esc(x)}</li>`).join('')}</ul><details><summary>Файлы оснований (${r.files.length})</summary><ul>${r.files.map(f => `<li>${esc(f.path)} — ${esc(f.state)} · ${link(f.reviewed_url, 'на дату проверки')} · ${link(f.current_url, 'на ревизии инвентаризации')}</li>`).join('')}</ul></details></article>`).join('')}<script>const input=document.querySelector('#filter'), rows=[...document.querySelectorAll('article')];function filter(){const q=input.value.toLowerCase();for(const r of rows)r.hidden=!r.textContent.toLowerCase().includes(q);document.querySelector('#count').textContent='Показано '+rows.filter(r=>!r.hidden).length+' из '+rows.length}input.addEventListener('input',filter);filter();</script></html>`;
}
