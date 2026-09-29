"""Bounded synthetic pilot batches: distinct PDFs and one multi-page volume."""
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas
from inspector_ml.paths import repo_root


def build(directory: Path, documents: int, pages: int):
    if not 1 <= documents <= 10 or not 1 <= pages <= 50:
        raise ValueError('pilot limits: 1..10 documents, 1..50 pages each')
    directory.mkdir(parents=True, exist_ok=False)
    font = ImageFont.truetype(str(repo_root()/'assets/fonts/NotoSans.ttf'), 42)
    files = []
    expected = {}
    for number in range(1, documents+1):
        name = f'T243-RD-{number:02d}.pdf'
        path = directory/name
        pdf = canvas.Canvas(str(path), pagesize=(600,800), invariant=1)
        for page in range(1, pages+1):
            image = Image.new('RGB',(1900,380),'white')
            draw = ImageDraw.Draw(image)
            draw.multiline_text((30,30),f'СИНТЕТИКА T243 · файл {number} · лист {page}\nКласс конструктивной пожарной опасности здания С1\nШирина двери 900 мм',font=font,fill='black',spacing=25)
            pdf.drawImage(ImageReader(image),35,650,width=1900*72/300,height=380*72/300)
            image.close()
            pdf.showPage()
        pdf.save()
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        files.append({'file_id':f'T243-{number}', 'file_name':name,'sha256':sha,
            'doc_stage':'RD','discipline':'АР','document_code':f'T243-{number}-АР','revision':'1',
            'approval_status':'FOR_CONSTRUCTION','approval_date':'2026-09-01',
            'sheet_page_range':f'1-{pages}' if pages>1 else '1',
            'signature_status':'SCAN_SIGNED','predecessor_id':None})
        expected[name]={'sha256':sha,'pages':pages}
    manifest={'object':{'object_id':'T243-PILOT','name':'СИНТЕТИКА T243 пилот',
        'address':'ВЫМЫШЛЕННЫЙ АДРЕС','profile':{'synthetic':True,'residential':True}},'files':files}
    (directory/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False))
    (directory/'expected.json').write_text(json.dumps(expected))
    print(json.dumps({'documents':documents,'pages':documents*pages,'fixture':str(directory)}))


if __name__=='__main__':
    build(Path(sys.argv[1]),int(sys.argv[2]),int(sys.argv[3]))
