"""Spatially constrained reading comparison on labelled synthetic hybrid PDFs.

The legacy baseline uses the unchanged whole-page parser. These fixtures carry
enough native text that its raster OCR is skipped; no different OCR engine is
used to manufacture the baseline. This is development evidence, not acceptance.
"""
import json
import sys
import unicodedata
from pathlib import Path

from rapidfuzz.distance import Levenshtein

from inspector_ml.parse import parse_pdf


def normalized(text):
    return ''.join(unicodedata.normalize('NFC',text).split())


def inside(box, target):
    if box is None:
        return False
    area=(box[2]-box[0])*(box[3]-box[1])
    intersection=max(0,min(box[2],target[2])-max(box[0],target[0]))*max(0,min(box[3],target[3])-max(box[1],target[1]))
    return area>0 and intersection/area>=.5


def iou(a,b):
    if a is None:
        return 0
    intersection=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    union=(a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-intersection
    return intersection/union if union>0 else 0


def score(lines, label):
    expected=normalized(label['text'])
    candidates=[' '.join(word['text'] for word in line if inside(word['bbox'],label['bbox'])) for line in lines]
    candidates=[text for text in candidates if text.strip()]
    best=min(candidates,key=lambda text: Levenshtein.distance(expected,normalized(text)),default='')
    edits=Levenshtein.distance(expected,normalized(best))
    return {'expected':label['text'],'observed':best,'edits':edits,'characters':len(expected),
            'exact':edits==0,'localized':bool(best),'bbox':label['bbox']}


def evaluate(fixture: Path, trace_path: Path):
    manifest=json.loads((fixture/'manifest.json').read_text())
    gold=json.loads((fixture/'expected.json').read_text())
    path=fixture/manifest['files'][0]['file_name']
    baseline=parse_pdf(path,gold['sha256'])
    if any(p.source!='text' for p in baseline.pages):
        raise ValueError('fixture did not exercise native-overlay legacy skip')
    old_lines=[[w.model_dump() for w in line.words] for p in baseline.pages for line in p.lines]
    trace=json.loads(trace_path.read_text())
    if trace['context']['sha256']!=gold['sha256'] or not trace['completeness']['publishable']:
        raise ValueError('trace is not a completed run of the labelled source')
    if trace['context']['policy']['name']!='regional-v1':
        raise ValueError('expected regional policy')
    regions=trace.get('regions') or [trace['page']]
    new_lines=[line['tokens'] for region in regions for line in region['lines']]
    # A vertical inscription may have been segmented into separate lines.
    # A second candidate joins only tokens inside its gold region from one
    # regional transcript, preserving model order (no expected-text sorting).
    new_lines += [[word for line in region['lines'] for word in line['tokens']] for region in regions]
    comparisons=[{'legacy':score(old_lines,label),'regional':score(new_lines,label)} for label in gold['labels']]
    metrics={}
    for route in ('legacy','regional'):
        rows=[entry[route] for entry in comparisons]
        metrics[route]={'exact_labels':sum(row['exact'] for row in rows),'labels':len(rows),
                        'localized_labels':sum(row['localized'] for row in rows),
                        'cer':sum(row['edits'] for row in rows)/sum(row['characters'] for row in rows)}
    word_locations=[]
    tokens=[word for region in regions for line in region['lines'] for word in line['tokens']]
    for label in gold['labels']:
        for word in label.get('words',[]):
            overlap=max((iou(token['bbox'],word['bbox']) for token in tokens
                         if normalized(token['text'])==normalized(word['text'])),default=0)
            word_locations.append({**word,'iou':overlap,'exact_and_localized':overlap>=.5})
    return {'evaluation_role':'synthetic_development','source_sha256':gold['sha256'],
            'run_id':trace['context']['run_id'],'configuration':trace['context']['configuration_fingerprint'],
            'normalization':'NFC and whitespace only; preserve symbols, comma, sign and unit powers',
            'candidate_scope':'one line or tokens inside one gold label from one region; no reordering',
            'word_localization':{'iou_threshold':.5,'exact_and_localized':sum(w['exact_and_localized'] for w in word_locations),
                                 'words':len(word_locations),'details':word_locations},
            'metrics':metrics,'labels':comparisons}


if __name__=='__main__':
    result=evaluate(Path(sys.argv[1]),Path(sys.argv[2]))
    Path(sys.argv[3]).write_text(json.dumps(result,ensure_ascii=False,indent=2))
    print(json.dumps(result['metrics']))
