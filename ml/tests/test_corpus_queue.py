import sqlite3
import hashlib
from teacher import corpus_queue as Q
import pytest


def test_drained_waves_bound_average_active_fraction():
    assert 10 / (10 + Q.wave_rest(10, .65)) == pytest.approx(.65)
    assert Q.wave_rest(10, 1) == 0
    with pytest.raises(ValueError):
        Q.wave_rest(10, 0)


def test_candidate_freezes_artifact_and_is_not_a_human_label():
    ex = {'code': 'M-007', 'page': 15, 'raw': '11', 'bbox': [0, 0, 1, 1]}
    one = Q.candidate('a'*64, ex, 'b'*64, {'geometry': 'coarse_band_not_word_boxes'})
    two = Q.candidate('a'*64, ex, 'c'*64, {})
    assert one['id'] != two['id']
    assert one['human_label'] is None
    assert one['status'] == 'machine_candidate'
    assert one['provenance']['geometry'] == 'coarse_band_not_word_boxes'


def test_resume_recovers_unfinished_jobs_and_insert_is_idempotent():
    db = sqlite3.connect(':memory:')
    Q.install_schema(db)
    db.execute("INSERT INTO sources(sha,kind,state) VALUES('source','pdf','running')")
    db.execute("INSERT INTO bands VALUES('source',1,0,'running',NULL)")
    Q.install_schema(db)
    assert db.execute('SELECT state FROM sources').fetchone()[0] == 'pending'
    assert db.execute('SELECT state FROM bands').fetchone()[0] == 'pending'
    row = Q.candidate('source', {'code': 'M-007', 'page': 1, 'raw': '11'}, 'artifact', {})
    Q.write_candidates(db, [row, row])
    assert db.execute('SELECT count(*) FROM candidates').fetchone()[0] == 1


def test_real_pdf_preparation_accounts_for_every_page_and_spools_candidates(tmp_path):
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from inspector_ml.paths import repo_root
    font = repo_root() / 'assets/fonts/Onest-Regular.ttf'
    pdfmetrics.registerFont(TTFont('queue-test', str(font)))
    original = tmp_path / 'source.pdf'
    c = canvas.Canvas(str(original))
    c.setFont('queue-test', 12)
    c.drawString(30, 750, 'Степень огнестойкости II')
    c.drawString(30, 725, 'Класс конструктивной пожарной опасности С0')
    c.showPage()
    c.showPage()
    c.save()
    sha = hashlib.sha256(original.read_bytes()).hexdigest()
    (tmp_path / 'cpu').mkdir()
    result = Q.prepare_source((sha, 'pdf', str(original), None, str(tmp_path), 'test-code'))
    assert result['pages'] == 2
    assert 2 in result['scans']
    assert result['count'] > 0
    assert len(Q.specs()) == 132
    import json
    row = json.loads((tmp_path / 'cpu' / (sha + '.jsonl')).read_text().splitlines()[0])
    assert row['artifact_sha256'] == sha
    assert row['provenance']['artifact_kind'] == 'original_document'
