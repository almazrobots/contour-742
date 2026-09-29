import pytest
from reportlab.pdfgen import canvas
from PIL import ImageChops
import pypdfium2 as pdfium
from inspector_ml.pipeline_geometry import pdf_regions, apply
from inspector_ml.pipeline_regions import regional_plan
from inspector_ml.pipeline_region_render import render_region
from inspector_ml.resource_scope import supervised_resources
from inspector_ml.resource_admission import Resources


@pytest.mark.parametrize('rotation',[0,90,180,270])
def test_region_pixels_match_full_render_with_cropbox_rotation(tmp_path,rotation):
    original=tmp_path/'original.pdf'; out=tmp_path/'rotated.pdf'
    c=canvas.Canvas(str(original),pagesize=(500,700));c.setFillColorRGB(1,0,0);c.rect(70,110,200,260,fill=1);c.showPage();c.save()
    with pdfium.PdfDocument(original) as doc:
        p=doc[0];p.set_cropbox(30,40,460,650);p.set_rotation(rotation);p.close();doc.save(out)
    page=pdf_regions(out,'a'*64)[0]
    tiles=regional_plan(page,dpi=144,tile_pixels=512,overlap_pixels=64)
    with pdfium.PdfDocument(out) as doc:
        p=doc[0];bm=p.render(scale=2);full=bm.to_pil().copy();bm.close();p.close()
    for tile in tiles:
        image,matrix=render_region(out,tile,144)
        x,y=apply(matrix,0,0);left,top=round(x*full.width),round(y*full.height)
        expected=full.crop((left,top,left+image.width,top+image.height))
        assert ImageChops.difference(image,expected).getbbox() is None
        assert max(image.size)<=512
        image.close();expected.close()
    full.close()


def test_a0_region_fits_budget_without_full_page_bitmap(tmp_path):
    path=tmp_path/'a0.pdf';c=canvas.Canvas(str(path),pagesize=(2384,3370));c.drawString(20,20,'A0 synthetic');c.showPage();c.save()
    region=regional_plan(pdf_regions(path,'a'*64)[0])[0]
    with supervised_resources(Resources(pixels=3_000_000,ram=48_000_000,tokens=100)):
        image,matrix=render_region(path,region,300)
        assert image.width*image.height<=1536**2
        assert matrix[0]<1 and matrix[3]<1
        image.close()
