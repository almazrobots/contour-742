import { describe, expect, it } from "vitest";
import { AnnotationTaskInput, AnnotationAnswer, annotationFingerprint, annotationQuestion, annotationInterval, chooseAnnotationParameter, chooseAnnotationStratum, splitAnnotationGroups } from "../src/domain/data-verification.ts";

const side = { sha256: "a".repeat(64), file_name: "example.pdf", kind: "pdf", page: 1, bbox: [0, 0, 1, 1], value: "11", quote: "Количество этажей 11", object_key: "OBJ-1", stage: "PD" };
describe("задание на разметку", () => {
  it("сопоставление не выдаётся за подтверждённую пару, для чтения нужна одна сторона", () => {
    const t = AnnotationTaskInput.parse({ parameter: "M-007", operation: "reading", sides: [side] });
    expect(annotationQuestion(t)).toContain("11");
    expect(() => AnnotationTaskInput.parse({ ...t, operation: "field_match" })).toThrow();
    expect(() => AnnotationTaskInput.parse({ ...t, sides: [side, side] })).toThrow();
  });
  it("плохие координаты, пути вместо SHA и несуществующие параметры отклоняются", () => {
    for (const patch of [{ sha256: "../secret" }, { bbox: [0.8, 0, 0.2, 1] }, { page: 0 }]) {
      expect(() => AnnotationTaskInput.parse({ parameter: "M-007", operation: "reading", sides: [{ ...side, ...patch }] })).toThrow();
    }
    expect(() => AnnotationTaskInput.parse({ parameter: "M-999", operation: "reading", sides: [side] })).toThrow();
  });
  it("fingerprint сохраняет контекст объекта и страницы при одинаковом SHA", () => {
    const input = (patch: any) => AnnotationTaskInput.parse({ parameter: "M-007", operation: "reading", sides: [{ ...side, ...patch }] });
    expect(annotationFingerprint(input({}))).not.toBe(annotationFingerprint(input({ object_key: "OBJ-2" })));
    expect(annotationFingerprint(input({}))).not.toBe(annotationFingerprint(input({ page: 2 })));
  });
});
it("балансировка даёт шанс малому параметру и использует воспроизводимую случайность", () => {
  const rows = [{ parameter: "M-007", ready: 10000, answered: 100 }, { parameter: "M-022", ready: 2, answered: 0 }];
  expect(chooseAnnotationParameter(rows, "undercovered", 0.5)).toBe("M-022");
  expect(chooseAnnotationParameter(rows, "ordinary", 0)).toBe("M-007");
  expect(chooseAnnotationParameter([], "ordinary", 0.3)).toBeNull();
});
it("разбиение удерживает версии объекта и одинаковые документы разных объектов вместе", () => {
  const rows = [{ id: "1", object_key: "A", shas: ["shared"] }, { id: "2", object_key: "B", shas: ["shared", "b"] }, { id: "3", object_key: "A", shas: ["a"] }];
  const groups = splitAnnotationGroups(rows);
  expect(groups["1"]).toEqual(groups["2"]);
  expect(groups["1"]).toEqual(groups["3"]);
});
it("не объявляет точность без выборки; интервал показывает неопределённость малой выборки",()=>{
  expect(annotationInterval(0,0)).toBeNull();
  const one=annotationInterval(1,1)!;expect(one.low).toBeCloseTo(.20655,4);expect(one.high).toBeCloseTo(1,10);
  const many=annotationInterval(95,100)!;expect(many.rate).toBe(.95);expect(many.low).toBeCloseTo(.88825,4);expect(many.high).toBeCloseTo(.97846,4);
  expect(()=>annotationInterval(2,1)).toThrow();expect(()=>annotationInterval(-1,10)).toThrow();
});
it("подтверждение предложенного значения не может одновременно исправлять его",()=>{
 const base={token:'token'.repeat(8),idempotency_key:'idempotent-value-1',corrected_value:'12'};
 expect(()=>AnnotationAnswer.parse({...base,answer:'YES'})).toThrow();
 expect(()=>AnnotationAnswer.parse({...base,answer:'UNSURE'})).toThrow();
 expect(AnnotationAnswer.parse({...base,answer:'NO'}).corrected_value).toBe('12');
});

it("выбор объекта и операции не зависит от объёма очереди, подтверждения и недавние показы снижают вес",()=>{
 const rows=[{object_key:'A',operation:'reading',verified_sources:20,recent:3},{object_key:'A',operation:'field_match',verified_sources:0,recent:0},{object_key:'B',operation:'reading',verified_sources:0,recent:0}];
 expect(chooseAnnotationStratum(rows,true,.5,0)?.object_key).toBe('B');
 expect(chooseAnnotationStratum(rows,false,0,.5)?.operation).toBe('field_match');
 expect(chooseAnnotationStratum([],false,0,0)).toBeNull();
 const even=[{object_key:'A',operation:'reading',verified_sources:0,recent:0},{object_key:'A',operation:'field_match',verified_sources:0,recent:0},{object_key:'B',operation:'reading',verified_sources:0,recent:0}];
 expect(chooseAnnotationStratum(even,false,.51,0)?.object_key).toBe('B');
});

it("недавний показ объекта учитывается после исчерпания показанной операции",()=>{
 const rows=[{object_key:'A',operation:'reading',verified_sources:0,recent:0,object_recent:0},{object_key:'B',operation:'reading',verified_sources:0,recent:0,object_recent:1}];
 expect(chooseAnnotationStratum(rows,false,.6,0)?.object_key).toBe('A');
});
