"""Conservative word reconciliation; provenance survives overlap deduplication.

No fuzzy text correction: different readings remain disputed alternatives.
Caller groups by immutable page identity before assembling reading order.
"""
import unicodedata

from .model import Line, ParsedDoc, Word
from .pipeline_contract import PageTrace, identity, transcription


def regional_quality(pages):
    """Quality of localized readings, not the ratio of ink to blank tiles.

    Empty regions retain their own quality and unlocalized observations in the
    immutable trace. They supply no words to the page's confidence average.
    An unavailable engine (ABSTAIN) still invalidates the physical page.
    Individual disputes remain on words and penalize the affected extraction.
    """
    populated = [(p, sum(len(line.words) for line in p.lines)) for p in pages]
    populated = [(p, n) for p, n in populated if n]
    measured = [(p.ocr_confidence, n) for p, n in populated if p.ocr_confidence is not None]
    confidence = round(sum(c*n for c, n in measured)/sum(n for _, n in measured), 1) if measured else None
    if any(p.quality == 'ABSTAIN' or p.execution_failures for p in pages):
        return 'ABSTAIN', confidence
    if not populated or any(p.quality == 'LOW_QUALITY' for p, _ in populated):
        return 'LOW_QUALITY', confidence
    return 'OK', confidence


def _overlap(a, b):
    if a is None or b is None:
        return 0.0
    intersection = max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))
    union = (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1])-intersection
    return intersection/union if union > 0 else 0.0


def reconcile_words(page_id: str, observations: list[dict]) -> list[dict]:
    """Each observation carries page_id, region_id, source, index and Word.

    Index is the stable token position inside that source region. Distinct tokens
    from the same source are never collapsed, even if their boxes coincide.
    """
    ordered = sorted(observations, key=lambda o: (o['region_id'], o['source'], o['index']))
    seen = set()
    result = []
    for observation in ordered:
        if observation['page_id'] != page_id:
            raise ValueError('cannot merge different source pages')
        source = {key: observation[key] for key in ('region_id', 'source', 'index')}
        key = (source['region_id'], source['source'], source['index'])
        if key in seen:
            raise ValueError('duplicate observation identity')
        seen.add(key)
        word = Word.model_validate(observation['word']).model_copy(deep=True)
        normalized = unicodedata.normalize('NFC', word.text).strip()
        match = None
        conflicts = []
        for candidate in result:
            # Compare against original observations, not an enlarged union box:
            # chains of overlapping boxes must not eat neighbouring tokens.
            originals = candidate['_originals']
            if any(s['region_id'] == source['region_id'] and s['source'] == source['source']
                   for s in candidate['sources']):
                continue
            if not all(_overlap(word.bbox, original.bbox) >= .75 for original in originals):
                continue
            if normalized == candidate['_text']:
                match = candidate
                break
            conflicts.append(candidate)
        if match is not None:
            match['sources'].append(source)
            match['_originals'].append(word)
            match['word'].disputed |= word.disputed
            continue
        entry = {'word': word, 'sources': [source], '_originals': [word], '_text': normalized}
        for conflict in conflicts:
            conflict['word'].disputed = True
            word.disputed = True
        result.append(entry)
    for entry in result:
        entry['id'] = identity('token', page_id, entry['sources'])
        del entry['_originals'], entry['_text']
    return result


def merge_documents(sha256: str, parts: list[dict]):
    """Build physical pages, keeping the immutable regional transcripts alongside.

    Retain original line grouping; geometry proximity alone is insufficient to
    join text across drawing views. Partial seam words remain available.
    """
    groups = {}
    traces = []
    for part in parts:
        doc = ParsedDoc.model_validate(part['doc'])
        trace = [PageTrace.model_validate(p) for p in part['pages']]
        if (doc.sha256 != sha256 or doc.kind != 'pdf' or len(trace) != 1
                or transcription(doc, [p.region for p in trace]) != trace):
            raise ValueError('regional document does not match transcript')
        region = trace[0].region
        if region.page_id != identity('page', sha256, region.page):
            raise ValueError('foreign page identity')
        group = groups.setdefault(region.page, {'page_id': region.page_id, 'parts': []})
        group['parts'].append((region, doc.pages[0], part.get('native', [])))
        traces.extend(trace)
    if len({t.region.id for t in traces}) != len(traces):
        raise ValueError('duplicate region')
    pages, bindings = [], []
    for number, group in sorted(groups.items()):
        observations, line_keys = [], {}
        regional = sorted(group['parts'], key=lambda item: item[0].id)
        template = regional[0][1]
        for region, page, native in regional:
            if (page.width, page.height, page.rotation) != (template.width, template.height, template.rotation):
                raise ValueError('inconsistent physical page geometry')
            for source, lines in [('ocr', page.lines), ('native', [Line.model_validate(v) for v in native])]:
                index = 0
                for line_index, line in enumerate(lines):
                    for word in line.words:
                        key = (region.id, source, index)
                        line_keys[key] = (region.id, source, line_index)
                        observations.append(dict(page_id=region.page_id, region_id=region.id,
                                                 source=source, index=index, word=word))
                        index += 1
        words = reconcile_words(group['page_id'], observations)
        lines = {}
        for entry in words:
            source = entry['sources'][0]
            key = line_keys[(source['region_id'], source['source'], source['index'])]
            lines.setdefault(key, []).append(entry['word'])
            bindings.append({'page_id': group['page_id'], 'page': number,
                             'id': entry['id'], 'word': entry['word'].model_dump(mode='json'),
                             'sources': entry['sources']})
        merged_lines = [Line(text=' '.join(w.text for w in values), words=values) for values in lines.values()]
        merged_lines.sort(key=lambda line: min(((w.bbox[1], w.bbox[0]) for w in line.words if w.bbox), default=(2, 2)))
        quality, confidence = regional_quality([p for _, p, _ in regional])
        disputed = sum(e['word'].disputed for e in words)
        pages.append(template.model_copy(update={
            'lines': merged_lines, 'source': 'ocr', 'disputed_words': disputed,
            'quality': quality,
            'engines': sorted({engine for _, p, _ in regional for engine in p.engines}),
            'execution_failures': sorted({f for _, p, _ in regional for f in p.execution_failures}),
            'ocr_confidence': confidence, 'agreement': None,
            'requisites': [r for _, p, _ in regional for r in p.requisites],
            'anchor_words': [w for _, p, _ in regional for w in p.anchor_words],
        }))
    return ParsedDoc(sha256=sha256, kind='pdf', pages=pages,
                     engine='+'.join(sorted({e for p in pages for e in p.engines}))), traces, bindings
