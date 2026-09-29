import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { gapEvidence } from './trace-gaps.mjs';

test('evidence preserves acceptance and does not upgrade verdict or colour', () => {
  const a = {id:'A', trace:['RULE','DLG'], code:'done', scope:'gpu', color:'blue', accept:'EM ≥ 0.90', why:'unknown'};
  const original = structuredClone(a);
  const result = gapEvidence(a, [{id:'RULE',code:['code'],tests:['test']},{id:'DLG:x',real:'DLG',code:['ui'],tests:[]}], null);
  assert.deepEqual(a, original);
  assert.equal(result.close,a.accept);
  assert.deepEqual(result.refs[1].code,['ui']);
  assert.match(result.stand,/неизвестно/);
  assert.equal(result.audit,null);
});
test('individual reaudits apply only to their atoms; uncertain findings stay visible', () => {
  const audit={audited_at:'old', revision:'old-sha', atoms:{A:{verdict:'REAL',uncertain:true,evidence:'limited'}}, reaudits:[{at:'new',revision:'new-sha',atoms:['OTHER']}]};
  const a={id:'A',trace:[],scope:'prototype',accept:'criterion',code:'done'};
  assert.equal(gapEvidence(a,[],audit).audit.revision,'old-sha');
  audit.reaudits.push({at:'repeat',revision:'repeat-sha',atoms:['A']});
  assert.equal(gapEvidence(a,[],audit).audit.revision,'repeat-sha');
  assert.equal(gapEvidence(a,[],audit).audit.uncertain,true);
});
test('historical failing stand result is not replaced by code readiness', () => {
  const e=gapEvidence({id:'TZA-9.1.1-03',scope:'gpu',code:'done',trace:[],accept:'hidden sample'},[],null);
  assert.match(e.stand,/не пройден/);
  assert.match(e.stand,/скрытой выборки не установлен/);
});
test('every model gap has an explicit requirement, remainder, next step, closure and evidence', () => {
  const m=parse(readFileSync('docs/gera/inspector/model.yaml','utf8'));
  const review=JSON.parse(readFileSync('docs/trace/GAPS-REVIEW.json','utf8')).model;
  assert.deepEqual(Object.keys(review).sort(),m.gaps.map(g=>g.id).sort());
  for(const g of m.gaps) for(const key of ['requirement','missing','next','close','evidence','stand']) assert.ok(review[g.id][key]?.length>15,`${g.id}: ${key}`);
  assert.doesNotMatch(m.gaps.find(g=>g.id==='GAP-INSP-07').title,/Нужна шкала/);
});

test('newer individual review wins over older batch metadata', () => {
  const a={id:'A',trace:[],scope:'prototype',accept:'criterion',code:'done'};
  const audit={audited_at:'2026-09-27',revision:'base',atoms:{A:{verdict:'REAL',reaudited:{at:'2026-09-29',revision:'individual'}}},reaudits:[{at:'2026-09-28',revision:'batch',atoms:['A']}]};
  assert.equal(gapEvidence(a,[],audit).audit.revision,'individual');
  audit.reaudits[0].at='2026-09-30';
  assert.equal(gapEvidence(a,[],audit).audit.revision,'batch');
});
