"""T-241: небольшие синтетические PDF для настоящего HTTP API; без внешнего корпуса."""
import hashlib
import json
import sys
from pathlib import Path
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT = Path(__file__).resolve().parents[1]
pdfmetrics.registerFont(TTFont("Noto", str(ROOT / "assets/fonts/NotoSans.ttf")))


def generate(out: Path):
    cases = [
        ("decrease", ["Степень огнестойкости здания — I."], ["Степень огнестойкости здания — II."], "CANDIDATE"),
        ("equal", ["Степень огнестойкости здания — II."], ["Степень огнестойкости здания — II."], "NEGATIVE_VERIFIED"),
        ("better", ["Степень огнестойкости здания — II."], ["Степень огнестойкости здания — I."], "NEGATIVE_VERIFIED"),
        ("conflict", ["Степень огнестойкости здания — II."], ["Степень огнестойкости здания — II.", "Степень огнестойкости здания — III."], "CLARIFICATION_REQUIRED"),
        ("missing", ["Степень огнестойкости здания — II."], ["Предел огнестойкости перекрытия REI 60."], "MISSING_EVIDENCE"),
        ("ambiguous", ["Степень огнестойкости здания — II."], ["Степень огнестойкости здания — II или III."], "NOT_COMPARABLE"),
        ("subjects", ["Корпус 1: степень огнестойкости — II.", "Корпус 2: степень огнестойкости — III."], ["Корпус 1: степень огнестойкости — II.", "Корпус 2: степень огнестойкости — III."], "NEGATIVE_VERIFIED"),
        ("different-subject", ["Корпус 1: степень огнестойкости — II."], ["Корпус 2: степень огнестойкости — II."], "NOT_COMPARABLE"),
        ("constraint", ["Степень огнестойкости здания — II."], ["Степень огнестойкости здания не ниже III."], "MISSING_EVIDENCE"),
    ]
    for index, (name, pd, rd, status) in enumerate(cases):
        folder = out / name
        folder.mkdir(parents=True, exist_ok=True)
        files = []
        for stage, discipline, lines in [("PD", "ПЗ", pd), ("RD", "АР", rd)]:
            code = f"П-2099-01-{index+1:03}-{discipline}"
            file_name = f"{stage}.pdf"
            p = folder / file_name
            c = canvas.Canvas(str(p), pagesize=(595, 842), invariant=True)
            c.setFont("Noto", 14)
            c.drawString(40, 790, "Противопожарные характеристики" if stage == "PD" else "Общие данные")
            for row, text in enumerate(lines):
                c.drawString(40, 735 - 28 * row, text)
            c.save()
            files.append(dict(file_id=stage, file_name=file_name, sha256=hashlib.sha256(p.read_bytes()).hexdigest(), doc_stage=stage,
                              discipline=discipline, document_code=code, revision="0", approval_status="APPROVED" if stage == "PD" else "FOR_CONSTRUCTION",
                              approval_date="2026-09-29", sheet_page_range="1"))
        (folder / "manifest.json").write_text(json.dumps(dict(object=dict(object_id=f"SYN-M022-{name}", name=f"Синтетический M-022 {name}"), files=files), ensure_ascii=False))
    (out / "cases.json").write_text(json.dumps([dict(name=n, status=s) for n, _, _, s in cases]))


if __name__ == "__main__":
    generate(Path(sys.argv[1]))
