import pytest
from reportlab.pdfgen import canvas
from inspector_ml import pipeline_region_ocr as module
from inspector_ml.model import Page,Line,Word,Requisite
from inspector_ml.pipeline_geometry import pdf_regions,apply
from inspector_ml.pipeline_regions import regional_plan


def test_region_uses_ensemble_with_native_text_and_maps_all_coordinates(tmp_path,monkeypatch):
    path=tmp_path/'native.pdf';c=canvas.Canvas(str(path),pagesize=(500,700));c.drawString(20,680,'NATIVE WORDS ARE NOT A REASON TO SKIP OCR');c.showPage();c.save()
    region=regional_plan(pdf_regions(path,'a'*64)[0],dpi=144,tile_pixels=512)[0]
    called=[]
    def ocr(image,number,width,height,rotation):
        called.append(image.size)
        return Page(page=number,width=width,height=height,rotation=rotation,source='ocr',engines=['anchor','reader'],
            lines=[Line(text='OCR',words=[Word(text='OCR',bbox=(.1,.2,.3,.4),disputed=True)])],
            requisites=[Requisite(kind='signature',bbox=(.2,.3,.4,.5),confidence=.8)],
            execution_failures=['reader:incomplete'])
    monkeypatch.setattr(module,'_ocr_image',ocr)
    doc,native,matrix=module.parse_region(path,'a'*64,region,144)
    assert len(called)==1 and max(called[0])<=512
    assert native and any('NATIVE' in line.text for line in native)
    word=doc.pages[0].lines[0].words[0]
    assert word.bbox==(*apply(matrix,.1,.2),*apply(matrix,.3,.4))
    assert word.disputed and doc.pages[0].execution_failures==['reader:incomplete']
    assert doc.pages[0].requisites[0].bbox==(*apply(matrix,.2,.3),*apply(matrix,.4,.5))


@pytest.mark.parametrize('box',[(0,0,2,1),(float('nan'),0,1,1),(.5,0,.1,1)])
def test_invalid_ocr_bbox_is_not_silently_clamped(box):
    with pytest.raises(ValueError):
        module.map_box(box,(1,0,0,1,0,0))


def test_blank_anchor_still_calls_reader_and_does_not_invent_word_coordinates(tmp_path,monkeypatch):
    from inspector_ml import ocr_gpu,vlm
    path=tmp_path/'blank.pdf';c=canvas.Canvas(str(path),pagesize=(100,100));c.showPage();c.save()
    region=pdf_regions(path,'a'*64)[0]
    monkeypatch.setattr(ocr_gpu,'engine_names',lambda _: ['ppocr-v5','vl-reader'])
    monkeypatch.setattr(module,'_ocr_image',lambda *args: Page(page=1,width=100,height=100,source='ocr',
        engines=['ppocr-v5'],lines=[]))
    calls=[]
    def read(model,image,prompt,**kwargs):
        calls.append(image.size)
        return 'MISSED INSCRIPTION'
    monkeypatch.setattr(vlm,'generate',read)
    diagnostics=[]
    doc,_,_=module.parse_region(path,'a'*64,region,diagnostics=diagnostics)
    assert len(calls)==1 and doc.pages[0].engines==['ppocr-v5','vl-reader']
    assert doc.pages[0].lines==[]
    assert diagnostics==[{'region_id':region.id,'text':'MISSED INSCRIPTION','status':'unlocalized','source':'vl-reader'}]
