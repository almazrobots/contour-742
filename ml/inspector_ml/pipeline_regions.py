"""Deterministic full-coverage regional plan in visible-page coordinates.

No image-based pruning: every tile is mandatory, including apparently empty areas.
Rendering/merge must explicitly opt into this plan; legacy policy remains separate.
"""
import math

from .pipeline_contract import Region, identity


def axis_windows(extent: float, size: int, overlap: int) -> list[tuple[float, float]]:
    if not math.isfinite(extent) or extent <= 0 or type(size) is not int or type(overlap) is not int or not 0 <= overlap < size:
        raise ValueError('invalid tile geometry')
    if extent <= size:
        return [(0.0, 1.0)]
    count = math.ceil((extent-size)/(size-overlap))+1
    if count > 1024:
        raise ValueError('regional plan exceeds bounded axis')
    starts = [min(i*(size-overlap), extent-size) for i in range(count)]
    return [(x/extent, min(1.0, (x+size)/extent)) for x in starts]


def regional_plan(page: Region, *, dpi: int = 300, tile_pixels: int = 1536,
                  overlap_pixels: int = 128, max_regions: int = 1024,
                  tile_height_pixels: int | None = None) -> list[Region]:
    if page.geometry is None or page.bbox != (0, 0, 1, 1):
        raise ValueError('regional plan requires whole-page PDF geometry')
    if type(dpi) is not int or not 72 <= dpi <= 600 or type(max_regions) is not int or max_regions < 1:
        raise ValueError('invalid regional resource policy')
    width, height = tile_pixels, tile_pixels if tile_height_pixels is None else tile_height_pixels
    if page.geometry.rotation in (90, 270):
        width, height = height, width
    xs = axis_windows(page.geometry.width*dpi/72, width, overlap_pixels)
    ys = axis_windows(page.geometry.height*dpi/72, height, overlap_pixels)
    if len(xs)*len(ys) > max_regions:
        raise ValueError('regional plan exceeds bounded region count')
    result = []
    for y0, y1 in ys:
        for x0, x1 in xs:
            box = (x0, y0, x1, y1)
            result.append(Region(id=identity('region', page.page_id, box), page_id=page.page_id,
                page=page.page, bbox=box, geometry=page.geometry))
    return result
