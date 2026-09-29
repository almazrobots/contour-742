"""T-237 synthetic API package. Execute on the GPU host, never on the laptop."""
from contextlib import closing
import hashlib
import io
import json
import os
from pathlib import Path

import pypdfium2 as pdfium
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from inspector_ml.parse import PDFIUM_LOCK

out = Path("/tmp/t237-pipeline-fixture")
out.mkdir(exist_ok=True)
pdfmetrics.registerFont(TTFont("T237Noto", "/app/assets/fonts/NotoSans.ttf"))
manifest = {"object": {"object_id": "T237-GPU-SYNTH", "name": "СИНТЕТИКА · T237 GPU",
    "address": "ВЫМЫШЛЕННЫЙ АДРЕС", "profile": {"synthetic": True, "residential": True}}, "files": []}

cases = [
    ("T237-PD-PZ", "PD", "ПЗ", "С0", False, [0]),
    ("T237-RD-AR", "RD", "АР", "С1", True, [0]),
    ("T237-PD-GEOMETRY", "PD", "КР", "С0", False, [0, 90, 180, 270]),
]
if os.environ.get("PIPELINE_RECOVERY_FIXTURE") == "1":
    cases.append(("T238-RD-RECOVERY", "RD", "АР", "С1", True, [0, 0, 0]))
for name, stage, discipline, value, scan, rotations in cases:
    raw = io.BytesIO()
    c = canvas.Canvas(raw, pagesize=(600, 800), invariant=1)
    for page_index, rotation in enumerate(rotations):
        c.setFont("T237Noto", 14)
        for row, text in enumerate(["СИНТЕТИКА · контрольный документ T237",
                "Класс конструктивной пожарной опасности здания " + value,
                "Ширина двери 900 мм", "Площадь помещения 124,50 м²"]):
            c.drawString(70, 670 - row * 45, text)
        if name == "T238-RD-RECOVERY":
            # Distinct crops keep later pages from reusing the first page's OCR cache.
            c.drawString(70, 440, f"Лист восстановления {page_index + 1}: размер {910 + page_index * 17} мм")
        c.showPage()
    c.save()
    path = out / (name + ".pdf")
    with PDFIUM_LOCK, pdfium.PdfDocument(raw.getvalue()) as doc:
        if scan:
            raster = canvas.Canvas(str(path), pagesize=(600, 800), invariant=1)
            for index in range(len(doc)):
                with closing(doc[index]) as page, closing(page.render(scale=300 / 72)) as bitmap:
                    image = bitmap.to_pil()
                    raster.drawImage(ImageReader(image), 0, 0, width=600, height=800)
                    image.close()
                    raster.showPage()
            raster.save()
        else:
            for i, rotation in enumerate(rotations):
                with closing(doc[i]) as page:
                    if len(rotations) > 1:
                        page.set_cropbox(30, 40, 570, 750)
                    page.set_rotation(rotation)
            doc.save(path)
    manifest["files"].append({"file_id": name, "file_name": path.name,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "doc_stage": stage,
        "discipline": discipline, "document_code": "T237-" + ("П-" if stage == "PD" else "Р-") + discipline,
        "revision": "1", "approval_status": "APPROVED" if stage == "PD" else "FOR_CONSTRUCTION",
        "approval_date": "2026-09-01", "sheet_page_range": f"1-{len(rotations)}",
        "signature_status": "SCAN_SIGNED", "predecessor_id": None})
(out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
print(json.dumps({"fixture": str(out), "files": len(manifest["files"])}))
