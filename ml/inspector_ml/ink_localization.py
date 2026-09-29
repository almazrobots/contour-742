"""Trim empty raster padding inside a detector word box; never change text."""
import math


def tighten_box(image, box):
    if box is None:
        return None
    if not all(math.isfinite(v) for v in box) or not (0 <= box[0] <= box[2] <= 1 and 0 <= box[1] <= box[3] <= 1):
        raise ValueError('invalid detector bbox')
    width, height = image.size
    left, top = math.floor(box[0]*width), math.floor(box[1]*height)
    right, bottom = math.ceil(box[2]*width), math.ceil(box[3]*height)
    if right <= left or bottom <= top:
        return box
    with image.crop((left, top, right, bottom)) as crop:
        with crop.convert('L') as gray:
            with gray.point(lambda value: 255 if value < 200 else 0) as mask:
                ink = mask.getbbox()
    if ink is None:
        return box
    x0, y0, x1, y1 = ink
    # One pixel margin preserves antialiasing; intersection cannot add a
    # neighbouring word or enlarge the detector's claimed source region.
    refined = (max(box[0], (left+x0-1)/width), max(box[1], (top+y0-1)/height),
               min(box[2], (left+x1+1)/width), min(box[3], (top+y1+1)/height))
    return refined if refined[0] < refined[2] and refined[1] < refined[3] else box
