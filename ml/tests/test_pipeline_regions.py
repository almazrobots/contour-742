import math
import pytest
from inspector_ml.pipeline_contract import Geometry, Region, identity
from inspector_ml.pipeline_regions import axis_windows, regional_plan


def page(w, h):
    pid = identity('page', 'a'*64, 1)
    return Region(id=identity('region',pid,[0,0,1,1]), page_id=pid,page=1,
        geometry=Geometry(width=w,height=h,rotation=0,media_box=(0,0,w,h),crop_box=(0,0,w,h),
            visible_to_pdf=(w,0,0,-h,0,h),pdf_to_visible=(1/w,0,0,-1/h,0,1)))


@pytest.mark.parametrize('w,h', [(595,842),(2384,3370),(3370,2384),(73,73)])
def test_all_visible_area_covered_with_bounded_rasters_and_overlap(w,h):
    tiles = regional_plan(page(w,h))
    assert tiles == regional_plan(page(w,h))
    assert len({t.id for t in tiles}) == len(tiles)
    xs = sorted(set((t.bbox[0],t.bbox[2]) for t in tiles))
    ys = sorted(set((t.bbox[1],t.bbox[3]) for t in tiles))
    assert len(tiles) == len(xs)*len(ys)  # Includes every Cartesian cell, no blank pruning.
    for windows, extent in ((xs,w*300/72),(ys,h*300/72)):
        assert windows[0][0] == 0 and windows[-1][1] == 1
        assert all((end-start)*extent <= 1536+1e-8 for start,end in windows)
        assert all((a[1]-b[0])*extent >= 128-1e-8 for a,b in zip(windows,windows[1:]))
    assert all(t.geometry == page(w,h).geometry for t in tiles)


def test_overflow_refuses_without_lowering_dpi():
    with pytest.raises(ValueError,match='region count'):
        regional_plan(page(2384,3370), max_regions=1)


@pytest.mark.parametrize('extent,size,overlap', [(math.inf,10,1),(0,10,1),(10,10,10),(10,10,-1)])
def test_invalid_geometry_refused(extent,size,overlap):
    with pytest.raises(ValueError):
        axis_windows(extent,size,overlap)


@pytest.mark.parametrize('rotation', [0, 90, 180, 270])
def test_rectangular_tiles_keep_pixel_budget_and_rotate_axes(rotation):
    w,h = (595,842) if rotation in (0,180) else (842,595)
    p=page(w,h)
    p.geometry.rotation=rotation
    tiles=regional_plan(p,tile_pixels=3072,tile_height_pixels=768)
    xs=sorted({(t.bbox[0],t.bbox[2]) for t in tiles})
    ys=sorted({(t.bbox[1],t.bbox[3]) for t in tiles})
    assert len(tiles)==len(xs)*len(ys)
    assert len(xs if rotation in (0,180) else ys)==1  # whole A4 line at 300 DPI
    for windows,extent in [(xs,w*300/72),(ys,h*300/72)]:
        assert windows[0][0]==0 and windows[-1][1]==1
        assert all((a[1]-b[0])*extent>=128-1e-8 for a,b in zip(windows,windows[1:]))
    assert all((t.bbox[2]-t.bbox[0])*w*300/72*(t.bbox[3]-t.bbox[1])*h*300/72<=3072*768+1e-6 for t in tiles)
