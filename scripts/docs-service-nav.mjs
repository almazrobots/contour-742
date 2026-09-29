// Standalone wide docs pages: isolated navigation, no scripts or global CSS.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export const serviceNavCss = `
.docs-service-nav{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px 24px;margin:0 0 14px;padding:0 0 12px;border-bottom:1px solid #e1e6ef;font:14px/1.5 "Golos Text",system-ui,sans-serif}
.docs-service-nav .docs-service-brand{font-weight:700;font-size:16px;color:#16202f;text-decoration:none}
.docs-service-nav .docs-service-brand span{font-size:12px;font-weight:400;color:#647184;margin-left:8px}
.docs-service-nav .docs-service-links{display:flex;flex-wrap:wrap;gap:8px 18px}
.docs-service-nav .docs-service-links a{color:#245bd1;text-underline-offset:3px}
.docs-service-meta{margin:12px 0 0;padding:9px 12px;border-radius:8px;background:#f4f6fa;color:#425063;font:12px/1.6 "Golos Text",system-ui,sans-serif;overflow-wrap:anywhere}
.docs-service-meta strong{color:#16202f;font-weight:600}
.docs-service-skip{position:absolute;top:-100px;left:16px;z-index:20;padding:10px 14px;border-radius:8px;background:#fff;color:#245bd1;font:14px/1.5 system-ui,sans-serif}
.docs-service-skip:focus{top:8px}
.docs-service-nav a:focus-visible,.docs-service-skip:focus-visible{outline:3px solid #245bd1;outline-offset:3px}
@media(max-width:560px){.docs-service-nav{gap:8px;margin-bottom:12px}.docs-service-nav .docs-service-brand span{display:block;margin-left:0}.docs-service-meta{font-size:12px}}
@media print{.docs-service-nav,.docs-service-skip{display:none}.docs-service-meta{background:transparent;border:1px solid #e1e6ef}}
`;

export function renderServiceNav({depth = 1, contentId = 'docs-service-content'} = {}) {
  if (!Number.isInteger(depth) || depth < 0 || depth > 10) throw new Error('Invalid service navigation depth');
  if (!/^[a-z][a-z0-9-]*$/.test(contentId)) throw new Error('Invalid service content anchor');
  const up = '../'.repeat(depth);
  return `<a class="docs-service-skip" href="#${contentId}">К содержимому</a><div class="docs-service-nav"><a class="docs-service-brand" href="${up}guide/index.html">Надзориум <span>База знаний</span></a><nav class="docs-service-links" aria-label="База знаний"><a href="${up}guide/index.html">Руководство</a><a href="${up}index.html">Все материалы</a><a href="${up}gera/TRACE-MAP.html">Trace Map</a></nav></div>`;
}

export function renderServiceMetadata({status, note, uiRevision, verifiedAt} = {}) {
  return `<p class="docs-service-meta"><strong>${esc(status || 'Актуальность не подтверждена')}</strong>${note ? ` · ${esc(note)}` : ''} · Версия UI: ${esc(uiRevision || 'не подтверждена')}${verifiedAt ? ` · Проверено: ${esc(verifiedAt)}` : ''}</p>`;
}
