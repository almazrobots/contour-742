"""Lossless, labelled hybrid fixtures; generation only on the remote runner.

Native overlay deliberately exceeds the legacy whole-page text threshold.
Raster inscriptions are rendered at exactly 300 DPI, not JPEG-compressed.
"""
import hashlib
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas

from inspector_ml.paths import repo_root


def build(directory: Path, fmt='A4'):
    directory.mkdir(parents=True, exist_ok=False)
    width,height = (595.28,841.89) if fmt=='A4' else (2383.94,3370.39)
    filename=f'T242-{fmt}-HYBRID.pdf'
    path=directory/filename
    c=canvas.Canvas(str(path),pagesize=(width,height),invariant=1)
    c.setFont('Helvetica',10)
    c.drawString(25,height-25,'SYNTHETIC NATIVE OVERLAY: OTHER TEXT IS RASTER')
    font=ImageFont.truetype(str(repo_root()/'assets/fonts/NotoSans.ttf'),34)
    labels=[]
    rows=[('Диаметр Ø12 мм',40,120,False),('Допуск ±0,5 мм',330,270,False),
          ('Отметка −3,250 м',40,390,False),('Площадь 125,7 м²',310,530,False),
          ('Размер 4200',80,620,True)]
    if fmt=='A0':
        rows.extend([('Шов 1536',360,1450,False),('Узел 27',width-170,height-120,False)])
    for text,x,top,vertical in rows:
        probe=Image.new('L',(1,1));bounds=ImageDraw.Draw(probe).textbbox((0,0),text,font=font)
        image=Image.new('L',(bounds[2]-bounds[0]+20,bounds[3]-bounds[1]+20),255)
        draw=ImageDraw.Draw(image)
        draw.text((10-bounds[0],10-bounds[1]),text,font=font,fill=0)
        words=[]
        prefix=''
        for word in text.split():
            box=draw.textbbox((10-bounds[0]+draw.textlength(prefix,font=font),10-bounds[1]),word,font=font)
            if vertical:
                box=(box[1],image.width-box[2],box[3],image.width-box[0])
            words.append({'text':word,'bbox':[(x+box[0]*72/300)/width,(top+box[1]*72/300)/height,
                                              (x+box[2]*72/300)/width,(top+box[3]*72/300)/height]})
            prefix+=word+' '
        if vertical:
            image=image.transpose(Image.Transpose.ROTATE_90)
        w,h=image.width*72/300,image.height*72/300
        c.drawImage(ImageReader(image),x,height-top-h,width=w,height=h)
        labels.append({'text':text,'bbox':[x/width,top/height,(x+w)/width,(top+h)/height],
                       'source':'raster','dpi':300,'vertical':vertical,'words':words})
        image.close();probe.close()
    c.showPage();c.save()
    sha=hashlib.sha256(path.read_bytes()).hexdigest()
    manifest={'object':{'object_id':f'T242-{fmt}','name':f'СИНТЕТИКА T242 {fmt}',
                        'address':'ВЫМЫШЛЕННЫЙ АДРЕС','profile':{'synthetic':True,'residential':True}},
              'files':[{'file_id':f'T242-{fmt}','file_name':filename,'sha256':sha,'doc_stage':'RD',
                        'discipline':'АР','document_code':f'T242-{fmt}-АР','revision':'1',
                        'approval_status':'FOR_CONSTRUCTION','approval_date':'2026-09-01',
                        'sheet_page_range':'1','signature_status':'SCAN_SIGNED','predecessor_id':None}]}
    (directory/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False))
    (directory/'expected.json').write_text(json.dumps({'sha256':sha,'format':fmt,'page':1,'labels':labels},ensure_ascii=False))
    return {'format':fmt,'labels':len(labels),'sha256':sha}


if __name__=='__main__':
    print(json.dumps(build(Path(sys.argv[1]),sys.argv[2] if len(sys.argv)>2 else 'A4')))
