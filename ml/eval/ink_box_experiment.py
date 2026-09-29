"""CPU-only development experiment on committed transcripts, not a new OCR run."""
import json
from pathlib import Path
import sys

from inspector_ml.ink_localization import tighten_box
from inspector_ml.pipeline_contract import Region
from inspector_ml.pipeline_region_render import render_region
from eval.regional_quality import evaluate


def experiment(fixture, trace_path, output):
    manifest = json.loads((fixture/'manifest.json').read_text())
    source = fixture/manifest['files'][0]['file_name']
    trace = json.loads(trace_path.read_text())
    original = evaluate(fixture, trace_path)
    changed = 0
    for transcript in trace.get('regions') or [trace['page']]:
        region = Region.model_validate(transcript['region'])
        image, transform = render_region(source, region, 300)
        try:
            a, _, _, d, e, f = transform
            for line in transcript['lines']:
                for token in line['tokens']:
                    box = token['bbox']
                    if box is None: continue
                    local = ((box[0]-e)/a, (box[1]-f)/d, (box[2]-e)/a, (box[3]-f)/d)
                    if not (0 <= local[0] < local[2] <= 1 and 0 <= local[1] < local[3] <= 1): continue
                    refined = tighten_box(image, local)
                    mapped = [refined[0]*a+e, refined[1]*d+f, refined[2]*a+e, refined[3]*d+f]
                    changed += mapped != box
                    token['bbox'] = mapped
        finally:
            image.close()
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    altered = output/'experimental-trace.json'
    altered.write_text(json.dumps(trace))
    revised = evaluate(fixture, altered)
    (output/'comparison.json').write_text(json.dumps({'role':'offline_localization_experiment',
        'changed_boxes':changed, 'before':original, 'after':revised}, ensure_ascii=False, indent=2))
    print(json.dumps({'changed_boxes':changed, 'before':original['word_localization']['exact_and_localized'],
        'after':revised['word_localization']['exact_and_localized'], 'words':revised['word_localization']['words'],
        'reading_before':original['metrics'], 'reading_after':revised['metrics']}))


if __name__ == '__main__':
    experiment(*map(Path, sys.argv[1:]))
