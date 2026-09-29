"""Owned, drained pilot rollback rehearsal; always restore the selected current release."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import runpy
import subprocess
import time

PROJECT='w1-feat-resource-ocr-incremental'
BRANCH='feat/resource-ocr-incremental'
BASE='sha256:34694c130d8791b84e4362f36e03985a6b23b1000da04a94fbb0f9f0b0b4b44d'
STAND=Path('/opt/w1-gate/stand')/PROJECT


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--previous',required=True);p.add_argument('--current',required=True)
    p.add_argument('--output',type=Path,required=True);p.add_argument('--deadline-utc',required=True)
    a=p.parse_args()
    assert os.geteuid()==0
    for value in (a.previous,a.current):
        assert len(value)==40 and all(c in '0123456789abcdef' for c in value)
    cutoff=datetime.fromisoformat(a.deadline_utc)
    assert cutoff.tzinfo and cutoff.timestamp()-time.time()>300
    helpers=runpy.run_path(str(Path(__file__).with_name('pipeline-backup.py')))
    helpers['drained']()
    counts=helpers['counts']()
    os.umask(0o077);a.output.mkdir(mode=0o700,parents=True,exist_ok=False)
    evidence={'started':time.time(),'before_counts':counts,'previous':a.previous,'current':a.current}
    def save(): (a.output/'evidence.json').write_text(json.dumps(evidence,indent=2))
    script=Path(__file__).with_name('stand.sh').resolve()
    def deploy(revision):
        helpers['drained']()
        subprocess.run(['bash',str(script),'up',BRANCH,revision,'--gpu-pilot',BASE],check=True,timeout=240)
        raw=subprocess.check_output(['python3','scripts/runner/verify-gpu-release.py',revision],cwd=STAND/'src',timeout=30)
        return json.loads(raw)
    save()
    try:
        evidence['rollback']=deploy(a.previous);save()
        assert helpers['counts']()==counts,'rollback changed stored record counts'
        # Existing saved result and all six page overlays must survive old API/UI.
        env=dict(os.environ,PIPELINE_SMOKE_PROCESS='P-20260929-0c18a78f',
                 PIPELINE_SMOKE_FIXTURE='/opt/resource-ocr/t237-gpu-fixture',
                 PIPELINE_SMOKE_OUTPUT=str(a.output/'previous-browser'))
        subprocess.run(['node','scripts/runner/pipeline-stand-smoke.mjs'],env=env,check=True,timeout=90)
        evidence['historical_browser_passed']=True;save()
    finally:
        try:
            evidence['restored']=deploy(a.current)
            evidence['after_counts']=helpers['counts']()
            evidence['counts_preserved']=evidence['after_counts']==counts
        except Exception as error:
            evidence['restore_error']=type(error).__name__
            raise
        finally:
            evidence['finished']=time.time();save()
    assert evidence['counts_preserved']
    print(json.dumps({'rollback':True,'restored':True,'counts_preserved':True,'evidence':str(a.output)}))


if __name__=='__main__': main()
