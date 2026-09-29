import pytest
from PIL import Image, ImageDraw

from inspector_ml.ink_localization import tighten_box


def test_localization_removes_padding_without_absorbing_a_neighbour():
    with Image.new('RGB', (100,100), 'white') as image:
        draw = ImageDraw.Draw(image)
        draw.rectangle((25,35,45,50), fill='black')
        draw.rectangle((65,35,90,50), fill='black')
        original = (.1,.2,.6,.7)
        refined = tighten_box(image, original)
        assert refined[0] >= original[0] and refined[1] >= original[1]
        assert refined[2] <= original[2] and refined[3] <= original[3]
        assert refined[0] <= .25 < .45 <= refined[2] < .65
        assert refined[1] <= .35 < .5 <= refined[3]


def test_blank_raster_preserves_detector_evidence():
    with Image.new('RGB', (100,100), 'white') as image:
        assert tighten_box(image, (.1,.2,.6,.7)) == (.1,.2,.6,.7)
        assert tighten_box(image, None) is None


@pytest.mark.parametrize('box', [(0,0,2,1), (float('nan'),0,1,1), (.5,0,.1,1)])
def test_invalid_detector_evidence_is_rejected(box):
    with Image.new('RGB', (10,10), 'white') as image:
        with pytest.raises(ValueError): tighten_box(image, box)
