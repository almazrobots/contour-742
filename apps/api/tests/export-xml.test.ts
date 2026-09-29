// OS-INSP-5.1.20, 5.1.21 (T-139, OWASP-аудит H6): XML-выгрузка протокола — текст данных как текст, недопустимые в XML 1.0
// символы убираются, выгрузка остаётся правильно построенным XML (L6 враждебные данные).
import { describe, expect, it } from "vitest";
import { protocolXml } from "../src/services/export.ts";

const BAD = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/;
const xml = (value: unknown) => protocolXml({ note: value } as any);

describe("XML-выгрузка протокола", () => {
  it("управляющие символы из документа убираются, табуляция и перевод строки остаются", () => {
    const out = xml("a\x00b\x0bc\x1fd\te\nf");
    expect(BAD.test(out)).toBe(false);
    expect(out).toContain("<note>abcd\te\nf</note>");
  });
  it("разметка из данных выводится как текст", () => {
    expect(xml('<font color="white">999</font> & <img src="/etc/hosts"/>')).toContain(
      "<note>&lt;font color=&quot;white&quot;&gt;999&lt;/font&gt; &amp; &lt;img src=&quot;/etc/hosts&quot;/&gt;</note>",
    );
  });
  it("одиночная половина суррогатной пары и U+FFFE убираются, целая пара (эмодзи) и кириллица остаются", () => {
    const out = xml("x\uD800y\uDC00z￾￿щ😀");
    expect(out).toContain("<note>xyzщ😀</note>");
  });
  it("число, пустое значение и null", () => {
    expect(xml(0)).toContain("<note>0</note>");
    expect(xml("")).toContain("<note></note>");
    expect(xml(null)).toContain("<note/>");
  });
});
