import pytest

from inspector_ml.model import Word
from inspector_ml.pipeline_region_merge import reconcile_words
from inspector_ml.pipeline_region_merge import regional_quality
from inspector_ml.model import Page, Line


def quality_page(*, words=1, quality='OK', confidence=90, disputed=False, failures=()):
    return Page(page=1,width=100,height=100,source='ocr',quality=quality,
        ocr_confidence=confidence,execution_failures=list(failures),
        lines=[Line(text=' '.join(['TEXT']*words),words=[Word(text='TEXT',disputed=disputed) for _ in range(words)])] if words else [])


def test_blank_regions_do_not_erase_confidence_of_localized_evidence():
    assert regional_quality([quality_page(words=3,confidence=90),quality_page(confidence=70),
        quality_page(words=0,quality='LOW_QUALITY',confidence=0)]) == ('OK',85)
    assert regional_quality([quality_page(words=0,quality='LOW_QUALITY')])[0]=='LOW_QUALITY'


def test_region_failures_and_actual_low_quality_remain_fail_closed():
    good=quality_page()
    for bad in [quality_page(words=0,quality='ABSTAIN'),quality_page(words=0,failures=['reader:timeout'])]:
        assert regional_quality([good,bad])[0]=='ABSTAIN'
    assert regional_quality([good,quality_page(quality='LOW_QUALITY')])[0]=='LOW_QUALITY'
    # A word dispute is retained for the extractor; unrelated page evidence is
    # not globally downgraded merely because two renderings disagree on a title.
    disputed=quality_page(disputed=True)
    assert regional_quality([good,disputed])[0]=='OK'
    assert disputed.lines[0].words[0].disputed


def observation(region, text='Ø12±0,5', box=(.1,.2,.2,.3), source='ocr', index=0, page='p1'):
    return dict(page_id=page, region_id=region, source=source, index=index,
                word=Word(text=text,bbox=box))


def test_overlap_dedup_preserves_all_sources_and_order_independence():
    observations=[observation('r2'), observation('r1'), observation('r1',source='native')]
    result=reconcile_words('p1',observations)
    assert result == reconcile_words('p1',list(reversed(observations)))
    assert len(result)==1 and len(result[0]['sources'])==3
    assert result[0]['word'].text=='Ø12±0,5'
    assert not result[0]['word'].disputed


def test_different_readings_stay_disputed_without_symbol_normalization():
    result=reconcile_words('p1',[observation('r1'),observation('r2',text='012+0.5')])
    assert len(result)==2 and all(item['word'].disputed for item in result)


def test_same_text_neighbours_and_unlocated_words_are_not_collapsed():
    result=reconcile_words('p1',[observation('r1'),observation('r2',box=(.3,.2,.4,.3)),
                               observation('r3',box=None),observation('r4',box=None)])
    assert len(result)==4


def test_same_source_tokens_and_partial_seam_readings_are_preserved():
    assert len(reconcile_words('p1',[observation('r1'),observation('r1',index=1)]))==2
    assert len(reconcile_words('p1',[observation('r1'),observation('r2',text='12',box=(.15,.2,.2,.3))]))==2


def test_other_page_or_duplicate_observation_is_rejected():
    with pytest.raises(ValueError,match='different source pages'):
        reconcile_words('p1',[observation('r1',page='p2')])
    with pytest.raises(ValueError,match='duplicate observation'):
        reconcile_words('p1',[observation('r1'),observation('r1')])
